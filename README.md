# AVAASS - Audio-Visual Assistive Speech System

AVAASS is a stutter aid application designed for people who suffer from stammering. The application allows users to communicate by whispering to their device, which then processes and converts this whispered input into clear, fluent speech.

## Features

- **Whisper Detection**: Special audio processing that detects and optimizes whispered speech
- **Noise Reduction**: Using RNNoise-wasm to clean up microphone input
- **ASR (Automatic Speech Recognition)**: Nvidia Parakeet CTC 0.6B model for accurate transcription
- **Predictive Text**: Intelligent word prediction to complete sentences
- **Voice Cloning TTS**: Coqui's XTTS v2 for converting text to natural speech in the user's own voice
- **Facial Animation**: Visual representation of speech with animated facial movements
- **Social Sharing**: Easy sharing of transcribed audio to platforms like Telegram, WhatsApp, and Twitter

## Technical Stack

- **Frontend**: React Native with Expo
- **Backend**: Flask with SocketIO for real-time communication
- **ML Models**:
  - ASR: Nvidia Parakeet CTC 0.6B
  - TTS: Coqui XTTS v2
  - Noise Reduction: RNNoise-wasm

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- Python 3.8+ with pip
- Expo CLI

### Backend Setup

```bash
cd backend
pip install -r requirements.txt
python app.py
```

The backend server will start on http://localhost:5000

### Frontend Setup

```bash
npm install
expo start
```

## How It Works

1. User starts the application and whispers into their device
2. The app detects whispered speech and processes it in real-time
3. Audio is cleaned with RNNoise and sent to the backend
4. The backend transcribes the whisper using Parakeet ASR
5. The transcribed text is converted to speech using XTTS v2
6. The synthesized speech is played back to the listener with facial animations
7. Users can share transcriptions via multiple platforms

## Accessibility Features

- Visual feedback with facial animations
- Adjustable microphone sensitivity for different whispering styles
- Dark/light theme support
- Text size customization

## License

[MIT License](LICENSE)
