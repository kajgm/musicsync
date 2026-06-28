import os
import numpy as np
import pyaudio
import time
from hue_entertainment_pykit import create_bridge, Entertainment, Streaming
from dotenv import load_dotenv

# Load environment variables from the .env file
load_dotenv()

# ==========================================
# CONFIGURATION
# ==========================================
# Hue Config
HUE_IP = os.getenv("HUE_IP")
HUE_USER = os.getenv("HUE_USER")
HUE_CLIENT_KEY = os.getenv("HUE_CLIENT_KEY")

# Spotify Config
SPOTIPY_CLIENT_ID = os.getenv("SPOTIPY_CLIENT_ID")
SPOTIPY_CLIENT_SECRET = os.getenv("SPOTIPY_CLIENT_SECRET")
SPOTIPY_REDIRECT_URI = os.getenv("SPOTIPY_REDIRECT_URI", "http://localhost:8888/callback")

# Verify critical keys are loaded
if not all([HUE_IP, HUE_USER, HUE_CLIENT_KEY, SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET]):
    raise ValueError("Missing one or more required environment variables. Check your .env file.")

# Audio Config
CHUNK = 1024
RATE = 44100
FPS_CAP = 40

# 1. SETUP HUE ENTERTAINMENT STREAM
bridge = create_bridge(
    ip_address=HUE_IP,
    username=HUE_USER,
    client_key=HUE_CLIENT_KEY,
)
entertainment = Entertainment(bridge)
configs = entertainment.get_entertainment_configs()
area = list(configs.values())[0] # Select your configured Entertainment Area

streaming = Streaming(bridge, area, entertainment)
streaming.set_color_space("rgb")
streaming.start_stream()

# 2. AUDIO CAPTURE SETUP (PyAudio)
CHUNK = 1024 # Number of audio frames per buffer
RATE = 44100 # Sample rate

p = pyaudio.PyAudio()
# Note: You may need to specify the exact input_device_index for your loopback interface (e.g., Stereo Mix on Windows, BlackHole on macOS)
stream = p.open(format=pyaudio.paInt16, channels=1, rate=RATE, input=True, frames_per_buffer=CHUNK)

# 3. DSP & SYNC LOOP
def get_frequency_bands(data):
    """Perform FFT to split audio into Bass, Mid, and High bins."""
    fft_data = np.abs(np.fft.fft(data))[:CHUNK//2]

    # Simplified frequency bucketing
    bass = np.mean(fft_data[0:10])     # ~0-250Hz
    mids = np.mean(fft_data[10:100])   # ~250-4000Hz
    highs = np.mean(fft_data[100:500]) # ~4000Hz+

    # Normalize values to 0.0 - 1.0 (requires a rolling max/scaling factor in production)
    return bass, mids, highs

def apply_smoothing(current_val, target_val, smoothing_factor=0.2):
    """Controls responsiveness to prevent jitter."""
    return current_val + (target_val - current_val) * smoothing_factor

try:
    print("Listening to audio and streaming to Hue...")
    current_brightness = [0.0, 0.0, 0.0]

    while True:
        # Read raw audio data
        raw_data = stream.read(CHUNK, exception_on_overflow=False)
        audio_data = np.frombuffer(raw_data, dtype=np.int16)

        # Analyze frequencies
        bass, mids, highs = get_frequency_bands(audio_data)

        # (Optional) Here you would poll Spotipy every ~10s to update the base RGB palette.
        # For now, we will use static colors representing a palette.
        palette = {
            "bass": (1.0, 0.0, 0.2), # Red/Pink
            "mids": (0.0, 0.8, 1.0), # Cyan
            "highs": (0.8, 0.0, 1.0) # Purple
        }

        # Apply your logic mapping (e.g., Light 0 -> Bass, Light 1 -> Mids, Light 2 -> Highs)
        # streaming.set_input takes (R, G, B, Light_ID)

        streaming.set_input((palette["bass"][0] * bass, palette["bass"][1] * bass, palette["bass"][2] * bass, 0))
        streaming.set_input((palette["mids"][0] * mids, palette["mids"][1] * mids, palette["mids"][2] * mids, 1))
        streaming.set_input((palette["highs"][0] * highs, palette["highs"][1] * highs, palette["highs"][2] * highs, 2))

        # Cap loop speed to ~30-40 updates per second to respect network limits
        time.sleep(0.025)

except KeyboardInterrupt:
    print("Stopping stream...")
finally:
    streaming.stop_stream()
    stream.stop()
    stream.close()
    p.terminate()