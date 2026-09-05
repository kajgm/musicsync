# musicsync

App to sync philips hue lights and music

A Python-based desktop application for Ubuntu that captures system audio in real-time, extracts frequency bands (Bass, Mids, Highs), syncs with the currently playing Spotify track's album art, and streams the data to Philips Hue lights via the Entertainment API (UDP DTLS) for zero-latency music syncing.

## ✨ Features

- **Zero-Latency Audio Capture:** Hooks natively into Ubuntu's PulseAudio/PipeWire monitor sinks. No virtual cables required.
- **Dynamic Color Palettes:** Runs a background thread to poll Spotify for the currently playing track, extracts the dominant colors from the album art, and maps them to your lights.
- **Frequency Separation:** Uses Fast Fourier Transform (FFT) to isolate Bass, Mids, and Highs, assigning them to individual lights.
- **Automatic Gain Control (AGC):** Normalizes audio output so lights react smoothly whether your system volume is at 10% or 100%.

---

## 🛠️ Prerequisites

### System Requirements

- **OS:** Ubuntu / Debian Linux
- **Python:** 3.8 or newer

### Hardware / Accounts

- **Philips Hue:** A Hue Bridge (v2/Square) and color-capable Hue lights.
- **Hue App Setup:** You MUST create an **Entertainment Area** in the official Philips Hue app before running this script.
- **Spotify Premium:** Required to poll the current playback state via the Spotify Web API.

---

## 🚀 Getting Started

Follow these steps to set up the project in an isolated Python Virtual Environment (`venv`).

### 1. Install System Dependencies

Before setting up Python, you need the underlying C-libraries for audio capture (PortAudio):

```bash
sudo apt update
sudo apt install python3-dev python3-pyaudio portaudio19-dev libasound2-dev python3-venv pavucontrol
```

### 2. Set Up the Virtual Environment

Navigate to your project directory and create the isolated environment:

```bash
# Create the virtual environment named 'venv'
python3 -m venv venv

# Activate the virtual environment
source venv/bin/activate
```

_(Note: You will know it is active when your terminal prompt starts with `(venv)`)_

### 3. Install Python Packages

With the virtual environment active, install the required Python libraries:

```bash
pip install pyaudio numpy spotipy colorthief requests hue-entertainment-pykit python-dotenv
```

---

## ⚙️ Configuration

To keep your credentials secure, this project uses a `.env` file.

### 1. Create the `.env` file

In the root of your project folder, create a file named `.env`:

```bash
touch .env
```

### 2. Populate your credentials

Open the `.env` file in your preferred text editor (e.g., `nano .env`) and add the following lines:

```env
# Hue Configuration
HUE_IP=192.168.X.X
HUE_USER=your_hue_username_here
HUE_CLIENT_KEY=your_hue_client_key_here

# Spotify Configuration
SPOTIPY_CLIENT_ID=your_spotify_client_id_here
SPOTIPY_CLIENT_SECRET=your_spotify_client_secret_here
SPOTIPY_REDIRECT_URI=http://localhost:8888/callback

```

### 🔑 How to get your API Keys:

- **Spotify:** Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/), create an app, and copy the Client ID and Client Secret. Ensure you add `http://localhost:8888/callback` as the Redirect URI in the app settings.
- **Philips Hue:** You will need to generate a username and an Entertainment Client Key by pairing with your Bridge. You can use tools like Postman or simple cURL scripts against the Hue Bridge REST API (`/api/`) pressing the link button on the Bridge to generate these tokens.

---

## ▶️ Running the Application

1. Ensure your virtual environment is activated (`source venv/bin/activate`).
2. Run the script:

```bash
python hue_sync.py
```

### First-Time Run (Spotify Auth)

On the very first run, the script will open a web browser asking you to log into Spotify and authorize the app. Once authorized, it will create a hidden `.cache` file in your directory to store your token for future use.

### Audio Routing (If lights aren't reacting)

If the script is running but the lights are unresponsive to audio:

1. Open a new terminal tab and launch the PulseAudio Volume Control:

```bash
pavucontrol
```

2. Go to the **Recording** tab.
3. Find the Python `ALSA plug-in` capture stream.
4. Change its input source from your microphone to **"Monitor of [Your Primary Output Device]"**.

---

## 🧹 Leaving the Virtual Environment

When you are done working on the project, you can deactivate the virtual environment to return to your normal system Python:

```bash
deactivate
```
