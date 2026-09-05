import os
import io
import time
import threading
import requests
import urllib3
import numpy as np
import pyaudio
import customtkinter as ctk
from collections import deque
from dotenv import load_dotenv
from colorthief import ColorThief
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from hue_entertainment_pykit import Bridge, Entertainment, Streaming

# Suppress unverified HTTPS warnings for local bridge REST calls
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Load environment variables
load_dotenv()

# ==========================================
# APP STATE & GLOBAL CONFIG
# ==========================================
STATE = {
    "connected": False,
    "sync_enabled": False,
    "global_sync_all": True,
    "use_spotify_palette": True,
    "spotify_authenticated": False,
    "smoothing": 0.3,
    "bridge_instance": None,
    "available_lights": {},
    "spotify_palette": [
        [1.0, 0.0, 0.2],
        [0.0, 0.8, 1.0],
        [0.8, 0.0, 1.0]
    ],
    "fft_visual_bars": [0.0] * 24  # Shared state for real-time visualizer canvas
}

CHUNK = 1024
RATE = 44100
FPS_CAP = 40
SP_CLIENT = None

# --- HELPERS ---
def rgb_to_hex(rgb):
    return '#{:02x}{:02x}{:02x}'.format(
        int(max(0, min(1, rgb[0])) * 255),
        int(max(0, min(1, rgb[1])) * 255),
        int(max(0, min(1, rgb[2])) * 255)
    )

def rgb_to_xy(r, g, b):
    """Converts RGB floats (0-1) to CIE XY coordinates for the Hue REST API."""
    r = ((r + 0.055) / 1.055) ** 2.4 if r > 0.04045 else r / 12.92
    g = ((g + 0.055) / 1.055) ** 2.4 if g > 0.04045 else g / 12.92
    b = ((b + 0.055) / 1.055) ** 2.4 if b > 0.04045 else b / 12.92

    X = r * 0.664511 + g * 0.154324 + b * 0.162028
    Y = r * 0.283881 + g * 0.680580 + b * 0.035539
    Z = r * 0.000088 + g * 0.085255 + b * 0.898999

    if (X + Y + Z) == 0:
        return [0.0, 0.0]

    return [round(X / (X + Y + Z), 4), round(Y / (X + Y + Z), 4)]

# ==========================================
# BACKGROUND WORKERS
# ==========================================
def spotify_worker():
    """Polls Spotify album art in background when authenticated."""
    global SP_CLIENT
    last_track_id = None

    while True:
        if STATE["use_spotify_palette"] and STATE["sync_enabled"] and SP_CLIENT:
            try:
                current_track = SP_CLIENT.current_user_playing_track()
                if current_track and current_track['item']:
                    track_id = current_track['item']['id']
                    if track_id != last_track_id:
                        last_track_id = track_id
                        image_url = current_track['item']['album']['images'][0]['url']
                        res = requests.get(image_url)
                        color_thief = ColorThief(io.BytesIO(res.content))
                        palette = color_thief.get_palette(color_count=3)

                        STATE["spotify_palette"] = [
                            [c / 255.0 for c in palette[0]],
                            [c / 255.0 for c in palette[1]],
                            [c / 255.0 for c in palette[2]]
                        ]
            except Exception as e:
                print(f"Spotify Poll Warning: {e}", flush=True)
        time.sleep(4)

def audio_hue_worker():
    """Handles audio processing, spectrum generation, and DTLS streaming."""
    # Force PulseAudio/PipeWire to capture system audio output instead of the mic
    os.environ["PULSE_SOURCE"] = "@DEFAULT_SINK@.monitor"

    streaming_active = False
    streaming = None

    try:
        p = pyaudio.PyAudio()

        # Open the default stream now forced to @DEFAULT_SINK@.monitor
        stream = p.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=RATE,
            input=True,
            frames_per_buffer=CHUNK
        )
        print("[Audio] Successfully bound to system audio output loopback.", flush=True)
    except Exception as e:
        print(f"[Audio Error] Initialization failed: {e}", flush=True)
        return

    history_len = int(RATE / CHUNK * 3)
    max_history = deque(maxlen=history_len)
    smoothed_light_state = {}

    while True:
        start_time = time.time()

        try:
            # Capture system audio
            raw_data = stream.read(CHUNK, exception_on_overflow=False)
            audio_data = np.frombuffer(raw_data, dtype=np.int16)

            # FFT processing & spectrum generation
            fft_data = np.abs(np.fft.fft(audio_data))[:128]
            current_max = np.max(fft_data)
            max_history.append(current_max if current_max > 0 else 1.0)
            rolling_max = max(max(max_history, default=1.0), 1.0)

            normalized_fft = np.clip(fft_data / rolling_max, 0.0, 1.0)

            # Update visualizer canvas bars
            bars = []
            bar_chunk = len(normalized_fft) // 24
            for idx in range(24):
                val = np.mean(normalized_fft[idx * bar_chunk:(idx + 1) * bar_chunk])
                bars.append(float(val))
            STATE["fft_visual_bars"] = bars

            if STATE["connected"] and STATE["sync_enabled"]:
                if not streaming_active:
                    try:
                        bridge = STATE["bridge_instance"]
                        entertainment = Entertainment(bridge)
                        configs = entertainment.get_entertainment_configs()
                        area = list(configs.values())[0]

                        repo = None
                        for val in vars(entertainment).values():
                            if hasattr(val, "put_configuration"):
                                repo = val
                                break
                            elif hasattr(val, "__dict__"):
                                for inner_val in vars(val).values():
                                    if hasattr(inner_val, "put_configuration"):
                                        repo = inner_val
                                        break
                                if repo:
                                    break

                        streaming = Streaming(bridge, area, repo)
                        streaming.set_color_space("rgb")
                        streaming.start_stream()

                        # Store channel list mapped inside the Hue Entertainment area
                        area_channels = getattr(area, "channels", [])
                        streaming_active = True
                        print("[Hue] DTLS Streaming active.", flush=True)
                    except Exception as e:
                        print(f"[Hue Error] Stream Initialization Failed: {e}", flush=True)
                        STATE["sync_enabled"] = False
                        time.sleep(1)
                        continue

                s = STATE["smoothing"]

                # Fetch valid channels from Hue Entertainment configuration
                channels = getattr(area, "channels", [])

                for idx, (lid, light_cfg) in enumerate(STATE["available_lights"].items()):
                    if lid not in smoothed_light_state:
                        smoothed_light_state[lid] = 0.0

                    # Determine channel ID from Entertainment area or fallback to index
                    if idx < len(channels):
                        ch_id = getattr(channels[idx], "channel_id", idx)
                    else:
                        ch_id = idx

                    is_active = STATE["global_sync_all"] and light_cfg["sync_enabled"]
                    if is_active:
                        min_bin = int(light_cfg["freq_min"] * (len(normalized_fft) - 1))
                        max_bin = int(light_cfg["freq_max"] * (len(normalized_fft) - 1))
                        if max_bin <= min_bin:
                            max_bin = min_bin + 1

                        raw_intensity = float(np.mean(normalized_fft[min_bin:max_bin]))
                        smoothed_light_state[lid] += (raw_intensity - smoothed_light_state[lid]) * s
                        target_intensity = smoothed_light_state[lid]

                        if STATE["use_spotify_palette"] and STATE["spotify_authenticated"]:
                            center_freq = (light_cfg["freq_min"] + light_cfg["freq_max"]) / 2.0
                            pal_idx = min(int(center_freq * 3), 2)
                            base_color = STATE["spotify_palette"][pal_idx]
                        else:
                            base_color = light_cfg["manual_rgb"]

                        out_r = base_color[0] * target_intensity * light_cfg["brightness"]
                        out_g = base_color[1] * target_intensity * light_cfg["brightness"]
                        out_b = base_color[2] * target_intensity * light_cfg["brightness"]
                    else:
                        out_r, out_g, out_b = 0.0, 0.0, 0.0

                    # Stream RGB values directly to channel ID
                    streaming.set_input((out_r, out_g, out_b, ch_id))

            else:
                if streaming_active and streaming:
                    try:
                        streaming.stop_stream()
                    except Exception:
                        pass
                    streaming_active = False

        except Exception as e:
            print(f"[Audio Loop Warning] {e}", flush=True)

        elapsed = time.time() - start_time
        time.sleep(max(0, (1.0 / FPS_CAP) - elapsed))

# ==========================================
# MODERN GUI WITH SPECTRUM GRAPHIC
# ==========================================
class App(ctk.CTk):
    def __init__(self):
        super().__init__()

        ctk.set_appearance_mode("Dark")
        self.title("Hue Audio Spectrum Controller")
        self.geometry("820x860")
        self.configure(fg_color="#08090d")
        self.resizable(False, False)

        font_family = "Ubuntu"
        self.font_title = ctk.CTkFont(family=font_family, size=18, weight="bold")
        self.font_section = ctk.CTkFont(family=font_family, size=12, weight="bold")
        self.font_body = ctk.CTkFont(family=font_family, size=11)
        self.font_small = ctk.CTkFont(family=font_family, size=10, weight="bold")

        # --- HEADER CONTROL CARD ---
        header = ctk.CTkFrame(self, fg_color="#10121a", corner_radius=14, border_width=1, border_color="#1a1d29")
        header.pack(fill="x", padx=20, pady=(20, 10))

        title_container = ctk.CTkFrame(header, fg_color="transparent")
        title_container.pack(side="left", padx=20, pady=16)

        title_lbl = ctk.CTkLabel(title_container, text="HUE SPECTRUM STUDIO", font=self.font_title, text_color="#ffffff")
        title_lbl.pack(anchor="w")

        self.status_badge = ctk.CTkLabel(title_container, text="DISCONNECTED", font=self.font_small, text_color="#f43f5e")
        self.status_badge.pack(anchor="w", pady=(2, 0))

        btn_box = ctk.CTkFrame(header, fg_color="transparent")
        btn_box.pack(side="right", padx=20)

        self.sp_btn = ctk.CTkButton(
            btn_box, text="Link Spotify", font=self.font_section, width=110,
            fg_color="#10b981", hover_color="#059669", height=34, corner_radius=8,
            command=self.authenticate_spotify
        )
        self.sp_btn.pack(side="left", padx=(0, 10))

        self.connect_btn = ctk.CTkButton(
            btn_box, text="Connect Bridge", font=self.font_section, width=120,
            fg_color="#6366f1", hover_color="#4f46e5", height=34, corner_radius=8,
            command=self.toggle_connection
        )
        self.connect_btn.pack(side="left")

        # --- LIVE AUDIO SPECTRUM GRAPHIC CARD ---
        vis_card = ctk.CTkFrame(self, fg_color="#10121a", corner_radius=14, border_width=1, border_color="#1a1d29")
        vis_card.pack(fill="x", padx=20, pady=6)

        vis_header = ctk.CTkFrame(vis_card, fg_color="transparent")
        vis_header.pack(fill="x", padx=16, pady=(12, 4))

        vis_lbl = ctk.CTkLabel(vis_header, text="REAL-TIME AUDIO FREQUENCY SPECTRUM", font=self.font_small, text_color="#6b7280")
        vis_lbl.pack(side="left")

        self.canvas_width = 740
        self.canvas_height = 80
        self.spectrum_canvas = ctk.CTkCanvas(
            vis_card, width=self.canvas_width, height=self.canvas_height,
            bg="#08090d", highlightthickness=0
        )
        self.spectrum_canvas.pack(padx=16, pady=(0, 12))

        # --- GLOBAL SYNC & OPTIONS BAR ---
        global_card = ctk.CTkFrame(self, fg_color="#10121a", corner_radius=14, border_width=1, border_color="#1a1d29")
        global_card.pack(fill="x", padx=20, pady=6)

        ctrl_row = ctk.CTkFrame(global_card, fg_color="transparent")
        ctrl_row.pack(fill="x", padx=16, pady=12)

        self.sync_switch = ctk.CTkSwitch(
            ctrl_row, text="Real-Time Sync Active", font=self.font_section,
            command=self.toggle_sync, progress_color="#10b981", button_hover_color="#059669"
        )
        self.sync_switch.deselect()
        self.sync_switch.pack(side="left", padx=(0, 20))

        # Explicit BooleanVar prevents CTkCheckBox AttributeError on teardown
        self.global_check_var = ctk.BooleanVar(value=True)
        self.global_check = ctk.CTkCheckBox(
            ctrl_row, text="Sync All Lights", font=self.font_body,
            variable=self.global_check_var,
            command=self.toggle_global_all, fg_color="#10b981", hover_color="#059669"
        )
        self.global_check.pack(side="left", padx=(0, 20))

        self.palette_switch = ctk.CTkSwitch(
            ctrl_row, text="Spotify Album Art Palette", font=self.font_body,
            command=self.toggle_palette, progress_color="#10b981", button_hover_color="#059669"
        )
        self.palette_switch.select()
        self.palette_switch.pack(side="left")

        # --- LIGHTS CONTROL CONTAINER ---
        lights_lbl = ctk.CTkLabel(self, text="INDIVIDUAL LIGHT SPECTRUM RANGE & MANUAL CONTROLS", font=self.font_small, text_color="#6b7280")
        lights_lbl.pack(anchor="w", padx=25, pady=(10, 2))

        self.lights_scroll = ctk.CTkScrollableFrame(self, fg_color="transparent")
        self.lights_scroll.pack(fill="both", expand=True, padx=20, pady=(0, 20))

        self.placeholder_lbl = ctk.CTkLabel(
            self.lights_scroll, text="Connect to your Hue Bridge above to display and configure lights.",
            font=self.font_body, text_color="#6b7280"
        )
        self.placeholder_lbl.pack(pady=60)

        self.light_widgets = {}

        # Start spectrum render loop (~30 FPS)
        self.render_spectrum_loop()

    # --- SPECTRUM GRAPHIC RENDERER ---
    def render_spectrum_loop(self):
        """Draws dynamic audio spectrum bars on the canvas."""
        self.spectrum_canvas.delete("all")
        bars = STATE["fft_visual_bars"]
        num_bars = len(bars)

        bar_width = (self.canvas_width - (num_bars * 2)) / num_bars

        for idx, val in enumerate(bars):
            x0 = idx * (bar_width + 2) + 2
            x1 = x0 + bar_width
            bar_h = val * (self.canvas_height - 10)
            y0 = self.canvas_height - bar_h
            y1 = self.canvas_height

            if idx < 8:
                fill_col = "#06b6d4"  # Bass
            elif idx < 16:
                fill_col = "#8b5cf6"  # Mids
            else:
                fill_col = "#ec4899"  # Highs

            self.spectrum_canvas.create_rectangle(x0, y0, x1, y1, fill=fill_col, outline="")

        self.after(30, self.render_spectrum_loop)

    # --- POPULATE LIGHT CARDS ---
    def populate_lights(self):
        # Safely remove old widgets
        for widget in self.lights_scroll.winfo_children():
            widget.destroy()

        self.light_widgets.clear()

        if not STATE["available_lights"]:
            lbl = ctk.CTkLabel(self.lights_scroll, text="No lights found on Bridge.", font=self.font_body, text_color="#f43f5e")
            lbl.pack(pady=60)
            return

        for lid, info in STATE["available_lights"].items():
            card = ctk.CTkFrame(self.lights_scroll, fg_color="#10121a", corner_radius=12, border_width=1, border_color="#1a1d29")
            card.pack(fill="x", pady=6)

            # --- TOP ROW: SYNC TOGGLE & MANUAL SLIDERS ---
            top_row = ctk.CTkFrame(card, fg_color="transparent")
            top_row.pack(fill="x", padx=16, pady=(12, 6))

            chk_var = ctk.BooleanVar(value=info["sync_enabled"])
            chk = ctk.CTkCheckBox(
                top_row, text=f"{info['name']} (ID: {lid})", font=self.font_section, text_color="#ffffff",
                variable=chk_var, fg_color="#10b981", hover_color="#059669",
                command=lambda l=lid: self.toggle_light_sync(l)
            )
            chk.pack(side="left")

            preview_box = ctk.CTkFrame(top_row, width=20, height=20, corner_radius=4, fg_color=rgb_to_hex(info["manual_rgb"]), border_width=1, border_color="#2a2e42")
            preview_box.pack(side="right", padx=(10, 0))

            bri_slider = ctk.CTkSlider(
                top_row, from_=0.0, to=1.0, width=100,
                command=lambda val, l=lid: self.update_manual_light(l),
                progress_color="#374151", button_color="#6366f1", button_hover_color="#4f46e5"
            )
            bri_slider.set(info["brightness"])
            bri_slider.pack(side="right", padx=10)

            bri_lbl = ctk.CTkLabel(top_row, text="Bright", font=self.font_small, text_color="#6b7280")
            bri_lbl.pack(side="right")

            # --- MIDDLE ROW: MANUAL RGB SLIDERS ---
            rgb_row = ctk.CTkFrame(card, fg_color="#08090d", corner_radius=8)
            rgb_row.pack(fill="x", padx=16, pady=(0, 8))

            rgb_sliders = {}
            colors_spec = [("R", "#f43f5e", info["manual_rgb"][0]),
                           ("G", "#10b981", info["manual_rgb"][1]),
                           ("B", "#3b82f6", info["manual_rgb"][2])]

            for code, col_hex, init_v in colors_spec:
                col_frame = ctk.CTkFrame(rgb_row, fg_color="transparent")
                col_frame.pack(side="left", expand=True, fill="x", padx=4, pady=4)

                c_lbl = ctk.CTkLabel(col_frame, text=code, font=self.font_small, text_color=col_hex, width=12)
                c_lbl.pack(side="left", padx=(2, 2))

                slider = ctk.CTkSlider(
                    col_frame, from_=0.0, to=1.0, height=12, progress_color=col_hex,
                    button_color="#ffffff", button_hover_color="#e5e7eb",
                    command=lambda val, l=lid: self.update_manual_light(l)
                )
                slider.set(init_v)
                slider.pack(side="left", fill="x", expand=True)
                rgb_sliders[code] = slider

            # --- BOTTOM ROW: CUSTOM SPECTRUM RANGE SLIDERS ---
            freq_row = ctk.CTkFrame(card, fg_color="#08090d", corner_radius=8)
            freq_row.pack(fill="x", padx=16, pady=(0, 12))

            f_lbl = ctk.CTkLabel(freq_row, text="Spectrum Range", font=self.font_small, text_color="#6b7280", width=100)
            f_lbl.pack(side="left", padx=10)

            min_s = ctk.CTkSlider(
                freq_row, from_=0.0, to=1.0, height=12, progress_color="#06b6d4",
                button_color="#06b6d4", button_hover_color="#22d3ee",
                command=lambda val, l=lid: self.update_spectrum_range(l)
            )
            min_s.set(info["freq_min"])
            min_s.pack(side="left", fill="x", expand=True, padx=5)

            max_s = ctk.CTkSlider(
                freq_row, from_=0.0, to=1.0, height=12, progress_color="#ec4899",
                button_color="#ec4899", button_hover_color="#f472b6",
                command=lambda val, l=lid: self.update_spectrum_range(l)
            )
            max_s.set(info["freq_max"])
            max_s.pack(side="left", fill="x", expand=True, padx=5)

            range_val_lbl = ctk.CTkLabel(
                freq_row, text=f"{int(info['freq_min']*100)}% - {int(info['freq_max']*100)}%",
                font=self.font_small, text_color="#9ca3af", width=80
            )
            range_val_lbl.pack(side="right", padx=10)

            self.light_widgets[lid] = {
                "check_var": chk_var,
                "check": chk,
                "preview": preview_box,
                "bri": bri_slider,
                "rgb": rgb_sliders,
                "min_s": min_s,
                "max_s": max_s,
                "range_lbl": range_val_lbl
            }

    # --- EVENT HANDLERS ---
    def toggle_connection(self):
        if not STATE["connected"]:
            hue_ip = os.getenv("HUE_IP")
            hue_user = os.getenv("HUE_USER")
            hue_key = os.getenv("HUE_CLIENT_KEY")

            try:
                url = f"https://{hue_ip}/api/{hue_user}/lights"
                res = requests.get(url, verify=False, timeout=4)
                if res.status_code == 200:
                    data = res.json()

                    STATE["available_lights"].clear()
                    total = len(data)
                    for idx, (lid, info) in enumerate(data.items()):
                        f_min = float(idx / max(1, total))
                        f_max = float((idx + 1) / max(1, total))

                        STATE["available_lights"][str(lid)] = {
                            "name": info.get("name", f"Light {lid}"),
                            "sync_enabled": True,
                            "brightness": 1.0,
                            "manual_rgb": [1.0, 0.0, 0.2],
                            "freq_min": f_min,
                            "freq_max": f_max
                        }

                    STATE["bridge_instance"] = Bridge(
                        ip_address=hue_ip, username=hue_user, clientkey=hue_key
                    )
                    STATE["connected"] = True

                    self.status_badge.configure(text="CONNECTED", text_color="#10b981")
                    self.connect_btn.configure(text="Disconnect", fg_color="#f43f5e", hover_color="#e11d48")
                    self.populate_lights()
            except Exception as e:
                print(f"Connection Error: {e}", flush=True)
                self.status_badge.configure(text="CONNECTION FAILED", text_color="#f43f5e")
        else:
            STATE["connected"] = False
            STATE["sync_enabled"] = False
            STATE["available_lights"].clear()

            self.sync_switch.deselect()
            self.status_badge.configure(text="DISCONNECTED", text_color="#f43f5e")
            self.connect_btn.configure(text="Connect Bridge", fg_color="#6366f1", hover_color="#4f46e5")
            self.populate_lights()

    def authenticate_spotify(self):
        self.sp_btn.configure(state="disabled", text="Check Browser...")

        def run_auth():
            global SP_CLIENT
            try:
                auth_mgr = SpotifyOAuth(
                    client_id=os.getenv("SPOTIPY_CLIENT_ID"),
                    client_secret=os.getenv("SPOTIPY_CLIENT_SECRET"),
                    redirect_uri=os.getenv("SPOTIPY_REDIRECT_URI", "http://127.0.0.1:8888/callback"),
                    scope="user-read-currently-playing",
                    open_browser=True
                )
                client = spotipy.Spotify(auth_manager=auth_mgr)
                client.current_user_playing_track()

                SP_CLIENT = client
                STATE["spotify_authenticated"] = True
                self.after(0, lambda: self.sp_btn.configure(text="Spotify Linked", state="disabled", fg_color="#1a1d29"))
            except Exception as e:
                print(f"Spotify Auth Error: {e}", flush=True)
                self.after(0, lambda: self.sp_btn.configure(text="Retry Auth", state="normal", fg_color="#10b981"))

        threading.Thread(target=run_auth, daemon=True).start()

    def toggle_sync(self):
        if not STATE["connected"]:
            self.sync_switch.deselect()
            self.status_badge.configure(text="CONNECT BRIDGE FIRST", text_color="#f43f5e")
            return

        is_active = bool(self.sync_switch.get())
        STATE["sync_enabled"] = is_active
        if is_active:
            self.status_badge.configure(text="SYNCING LIVE", text_color="#10b981")
        else:
            self.status_badge.configure(text="CONNECTED", text_color="#10b981")

    def toggle_global_all(self):
        is_checked = self.global_check_var.get()
        STATE["global_sync_all"] = is_checked

        for lid, w in self.light_widgets.items():
            STATE["available_lights"][lid]["sync_enabled"] = is_checked
            w["check_var"].set(is_checked)

    def toggle_light_sync(self, lid):
        w = self.light_widgets[lid]
        STATE["available_lights"][lid]["sync_enabled"] = w["check_var"].get()

    def toggle_palette(self):
        STATE["use_spotify_palette"] = bool(self.palette_switch.get())

    def update_spectrum_range(self, lid):
        w = self.light_widgets[lid]
        min_v = w["min_s"].get()
        max_v = w["max_s"].get()

        if min_v >= max_v:
            min_v = max(0.0, max_v - 0.05)
            w["min_s"].set(min_v)

        STATE["available_lights"][lid]["freq_min"] = min_v
        STATE["available_lights"][lid]["freq_max"] = max_v
        w["range_lbl"].configure(text=f"{int(min_v*100)}% - {int(max_v*100)}%")

    def update_manual_light(self, lid):
        if not STATE["connected"]:
            return

        w = self.light_widgets[lid]
        r = w["rgb"]["R"].get()
        g = w["rgb"]["G"].get()
        b = w["rgb"]["B"].get()
        bri = w["bri"].get()

        STATE["available_lights"][lid]["manual_rgb"] = [r, g, b]
        STATE["available_lights"][lid]["brightness"] = bri
        w["preview"].configure(fg_color=rgb_to_hex([r, g, b]))

        if not STATE["sync_enabled"]:
            def send_rest():
                try:
                    hue_ip = os.getenv("HUE_IP")
                    hue_user = os.getenv("HUE_USER")
                    url = f"https://{hue_ip}/api/{hue_user}/lights/{lid}/state"
                    payload = {
                        "on": True,
                        "bri": int(bri * 254),
                        "xy": rgb_to_xy(r, g, b)
                    }
                    requests.put(url, json=payload, verify=False, timeout=1)
                except Exception as e:
                    print(f"REST Light Update Error: {e}", flush=True)

            threading.Thread(target=send_rest, daemon=True).start()

if __name__ == "__main__":
    threading.Thread(target=spotify_worker, daemon=True).start()
    threading.Thread(target=audio_hue_worker, daemon=True).start()

    app = App()
    app.mainloop()