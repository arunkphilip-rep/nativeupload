import os
import json
import uuid
import logging
import requests
import time
import numpy as np
import torch
import soundfile as sf
from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from flask_socketio import SocketIO, emit
import datetime
import queue
import threading
import base64
import io

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Configuration
UPLOAD_FOLDER = "uploads"
RESPONSES_FOLDER = "responses"
TRANSCRIPTIONS_FOLDER = "transcriptions"
TTS_OUTPUT_FOLDER = "tts_output"
MODEL_CACHE = "model_cache"
PREDICTION_QUEUE = queue.Queue()

# Update CORS configuration
CORS(app)

# Ensure necessary folders exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(RESPONSES_FOLDER, exist_ok=True)
os.makedirs(TRANSCRIPTIONS_FOLDER, exist_ok=True)
os.makedirs(TTS_OUTPUT_FOLDER, exist_ok=True)
os.makedirs(MODEL_CACHE, exist_ok=True)

# Global model cache
asr_model = None
asr_processor = None
tts_model = None
noise_reduction_model = None

def load_models():
    """Load ASR and TTS models"""
    global asr_model, asr_processor, tts_model, noise_reduction_model
    
    try:
        logger.info("Loading RNNoise model...")
        try:
            # Import here to avoid loading unless necessary
            import rnnoiseasm
            noise_reduction_model = rnnoiseasm.RNNoiseProcessor()
            logger.info("RNNoise model loaded successfully")
        except ImportError:
            logger.warning("RNNoise package not installed. Noise reduction will be disabled.")
            noise_reduction_model = None
        
        logger.info("Loading Parakeet ASR model...")
        # Import and load ASR model
        try:
            from transformers import AutoModelForCTC, AutoProcessor
            asr_processor = AutoProcessor.from_pretrained("nvidia/parakeet-ctc-0.6b-asr", cache_dir=MODEL_CACHE)
            asr_model = AutoModelForCTC.from_pretrained("nvidia/parakeet-ctc-0.6b-asr", cache_dir=MODEL_CACHE)
            logger.info("ASR model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load ASR model: {e}")
            asr_model = None
            asr_processor = None
        
        logger.info("Loading XTTS model...")
        # Import and load TTS model - this can take a while
        try:
            from TTS.api import TTS
            tts_model = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=torch.cuda.is_available())
            logger.info("TTS model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load TTS model: {e}")
            tts_model = None
        
        return True
    except Exception as e:
        logger.error(f"Error loading models: {e}")
        return False

# Start loading models in a background thread
model_loading_thread = threading.Thread(target=load_models, daemon=True)
model_loading_thread.start()

def resample_audio(audio_data, orig_sample_rate, target_sample_rate=48000):
    """Resample audio to target sample rate"""
    try:
        import librosa
        resampled_audio = librosa.resample(
            audio_data, 
            orig_sr=orig_sample_rate, 
            target_sr=target_sample_rate
        )
        return resampled_audio, target_sample_rate
    except Exception as e:
        logger.error(f"Error resampling audio: {e}")
        return audio_data, orig_sample_rate

def process_audio(audio_data, sample_rate=16000):
    """Process audio with RNNoise for noise reduction"""
    if noise_reduction_model is None:
        logger.warning("RNNoise model not loaded, skipping noise reduction")
        return audio_data
        
    try:
        # RNNoise expects 16-bit PCM at 48kHz
        if sample_rate != 48000:
            audio_data, sample_rate = resample_audio(audio_data, sample_rate, 48000)
        
        # Convert float audio to int16 PCM
        audio_pcm = (audio_data * 32767).astype(np.int16)
        
        # Process the audio for noise reduction
        denoised_pcm = noise_reduction_model.process_frame(audio_pcm)
        
        # Convert back to float
        denoised_audio = denoised_pcm.astype(np.float32) / 32767.0
        
        return denoised_audio
    except Exception as e:
        logger.error(f"Error in noise reduction: {e}")
        return audio_data  # Return original audio if processing fails

def transcribe_audio(audio_path):
    """Transcribe audio using Parakeet ASR model"""
    start_time = time.time()
    
    if asr_model is None or asr_processor is None:
        return {"error": "ASR model not loaded"}
    
    try:
        import librosa
        
        # Load audio file
        audio_array, sample_rate = librosa.load(audio_path, sr=16000)
        
        # Apply noise reduction
        audio_array = process_audio(audio_array, sample_rate)
        
        # Process with ASR - using the global processor
        input_features = asr_processor(audio_array, sampling_rate=sample_rate, return_tensors="pt").input_features
        
        # Get prediction
        with torch.no_grad():
            predicted_ids = asr_model.generate(input_features)
        
        # Decode prediction
        transcription = asr_processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
        
        # Get additional info
        audio_duration = len(audio_array) / sample_rate
        
        # Generate timestamp
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        transcription_id = f"{timestamp}_{uuid.uuid4().hex[:8]}"
        
        # Calculate processing time
        processing_time = time.time() - start_time
        
        # Save transcription
        transcription_data = {
            "language": "en",  # Could be detected or provided by model
            "language_probability": 1.0,
            "duration": audio_duration,
            "segments": [
                {
                    "start": 0.0,
                    "end": audio_duration,
                    "text": transcription
                }
            ],
            "full_text": transcription,
            "processing_time": processing_time,
            "session_id": transcription_id  # Store session ID for lookup
        }
        
        transcription_path = os.path.join(TRANSCRIPTIONS_FOLDER, f"transcription_{transcription_id}.json")
        with open(transcription_path, 'w') as f:
            json.dump(transcription_data, f, indent=2)
            
        return {
            "transcription": transcription,
            "transcription_id": transcription_id,
            "duration": audio_duration,
            "processing_time": processing_time
        }
        
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        return {"error": f"Failed to transcribe audio: {str(e)}"}

def generate_tts(text, voice_sample=None):
    """Generate TTS using the provided text and optional voice sample for cloning"""
    start_time = time.time()
    
    if tts_model is None:
        return {"error": "TTS model not loaded"}
    
    if not text or text.strip() == "":
        return {"error": "Empty text provided for TTS"}
    
    try:
        # Generate a unique ID for the output file
        output_filename = f"tts_{uuid.uuid4()}.wav"
        output_path = os.path.join(TTS_OUTPUT_FOLDER, output_filename)
        
        # Use voice sample for cloning if provided
        if voice_sample and os.path.exists(voice_sample):
            tts_model.tts_to_file(text, speaker_wav=voice_sample, file_path=output_path)
        else:
            # Use default voice if no sample is provided
            tts_model.tts_to_file(text, file_path=output_path)
            
        processing_time = time.time() - start_time
        
        return {
            "tts_audio": output_filename,
            "tts_time": processing_time
        }
        
    except Exception as e:
        logger.error(f"TTS generation error: {e}")
        return {"error": f"Failed to generate speech: {str(e)}"}

def process_queue():
    """Process items in the prediction queue"""
    while True:
        try:
            # Get an item from the queue (blocks until an item is available)
            item = PREDICTION_QUEUE.get()
            
            audio_path = item.get("audio_path")
            session_id = item.get("session_id")
            
            if not audio_path or not os.path.exists(audio_path):
                logger.error(f"Invalid audio path: {audio_path}")
                PREDICTION_QUEUE.task_done()
                continue
                
            response_data = {}
            
            # First transcribe the audio
            logger.info(f"Transcribing audio: {audio_path}")
            transcription_result = transcribe_audio(audio_path)
            
            if "error" not in transcription_result:
                logger.info(f"Transcription successful: {transcription_result.get('transcription')}")
                response_data.update(transcription_result)
                
                # Then generate TTS from the transcription
                logger.info(f"Generating TTS for: {transcription_result.get('transcription')}")
                tts_result = generate_tts(transcription_result.get('transcription'), voice_sample=audio_path)
                
                if "error" not in tts_result:
                    logger.info(f"TTS generation successful: {tts_result.get('tts_audio')}")
                    response_data.update(tts_result)
                    # Include URL for TTS audio
                    response_data["tts_audio_url"] = f"/api/tts/{tts_result['tts_audio']}"
                else:
                    logger.error(f"TTS generation failed: {tts_result.get('error')}")
                    response_data["tts_error"] = tts_result.get("error")
            else:
                logger.error(f"Transcription failed: {transcription_result.get('error')}")
                response_data = transcription_result
                
            # Save response to file
            filename = os.path.basename(audio_path)
            response_file = os.path.join(RESPONSES_FOLDER, f"{filename}.json")
            
            response_data_with_metadata = {
                "timestamp": datetime.datetime.utcnow().isoformat(),
                "filename": filename,
                "status": "error" if "error" in response_data else "success",
                "session_id": session_id,
                "colab_response": response_data
            }
            
            with open(response_file, 'w') as f:
                json.dump(response_data_with_metadata, f, indent=2)
                
            # Emit result to connected clients via websocket
            logger.info(f"Emitting transcription_complete event for session: {session_id}")
            socketio.emit('transcription_complete', {
                "session_id": session_id,
                "result": response_data
            })
            
            # Remove the audio file if it exists
            if os.path.exists(audio_path):
                os.remove(audio_path)
                logger.info(f"Removed audio file: {audio_path}")
                
        except Exception as e:
            logger.exception(f"Error processing queue item: {e}")
        finally:
            # Mark task as done even if there was an exception
            PREDICTION_QUEUE.task_done()
            
# Start the processing thread
processing_thread = threading.Thread(target=process_queue, daemon=True)
processing_thread.start()

@app.route('/api/upload', methods=['POST'])
def upload_audio():
    try:
        logger.info("Received upload request")
        
        if 'file' not in request.files:
            return jsonify({'error': 'Audio file is missing'}), 400

        audio_file = request.files['file']
        if not audio_file.filename:
            return jsonify({'error': 'No selected file'}), 400

        # Save uploaded file
        file_ext = os.path.splitext(audio_file.filename)[1].lower()
        if not file_ext:
            file_ext = ".m4a"  # Default extension if none provided
            
        filename = f"{uuid.uuid4()}{file_ext}"
        filepath = os.path.join(UPLOAD_FOLDER, filename)
        
        audio_file.save(filepath)
        logger.info(f"File saved: {filepath}")

        # Generate a session ID for tracking this request
        session_id = str(uuid.uuid4())
        
        # Add to processing queue
        PREDICTION_QUEUE.put({
            "audio_path": filepath,
            "session_id": session_id
        })
        
        return jsonify({
            "status": "processing",
            "message": "Audio uploaded and being processed",
            "session_id": session_id
        })

    except Exception as e:
        logger.exception("Upload error")
        return jsonify({"error": str(e)}), 500

@app.route('/api/transcription/<session_id>', methods=['GET'])
def get_transcription(session_id):
    """Get transcription results for a session"""
    try:
        # First check transcriptions folder
        for filename in os.listdir(TRANSCRIPTIONS_FOLDER):
            if not filename.endswith('.json'):
                continue
                
            file_path = os.path.join(TRANSCRIPTIONS_FOLDER, filename)
            with open(file_path, 'r') as f:
                data = json.load(f)
                
            if data.get('session_id') == session_id:
                # Return the transcription data
                return jsonify(data)
        
        # Then check responses folder
        for filename in os.listdir(RESPONSES_FOLDER):
            if not filename.endswith('.json'):
                continue
                
            file_path = os.path.join(RESPONSES_FOLDER, filename)
            with open(file_path, 'r') as f:
                data = json.load(f)
                
            if data.get('session_id') == session_id:
                # Return the transcription data
                return jsonify(data['colab_response'])
                
        # If not found, it might still be processing
        return jsonify({"status": "processing", "message": "Still processing"}), 202
        
    except Exception as e:
        logger.exception("Error fetching transcription")
        return jsonify({"error": str(e)}), 500

@app.route('/api/tts/<filename>', methods=['GET'])
def get_tts_audio(filename):
    """Serve TTS audio file"""
    try:
        file_path = os.path.join(TTS_OUTPUT_FOLDER, filename)
        if os.path.exists(file_path):
            return send_file(file_path, mimetype='audio/wav')
        else:
            return jsonify({"error": "Audio file not found"}), 404
    except Exception as e:
        logger.exception("Error serving TTS file")
        return jsonify({"error": str(e)}), 500

@app.route('/api/stream', methods=['POST'])
def stream_audio_chunk():
    """Process streaming audio chunks"""
    try:
        if 'audio' not in request.files:
            return jsonify({'error': 'Audio chunk is missing'}), 400

        audio_chunk = request.files['audio']
        session_id = request.form.get('session_id', str(uuid.uuid4()))
        chunk_index = request.form.get('chunk_index', '0')
        
        # Save chunk temporarily
        chunk_path = os.path.join(UPLOAD_FOLDER, f"{session_id}_chunk_{chunk_index}.wav")
        audio_chunk.save(chunk_path)
        
        # Check if file exists and is valid
        if not os.path.exists(chunk_path) or os.path.getsize(chunk_path) == 0:
            return jsonify({'error': 'Failed to save audio chunk'}), 500
        
        try:
            # Process chunk
            chunk_data, sample_rate = sf.read(chunk_path)
            
            # Apply noise reduction
            denoised_data = process_audio(chunk_data, sample_rate)
            
            # Save processed chunk for debugging (optional)
            # sf.write(os.path.join(UPLOAD_FOLDER, f"{session_id}_processed_{chunk_index}.wav"), denoised_data, sample_rate)
        except Exception as e:
            logger.error(f"Error processing audio chunk: {e}")
            # Continue even if processing fails
        
        # If this is marked as a final chunk, process the complete audio
        is_final = request.form.get('is_final', 'false').lower() == 'true'
        
        if is_final:
            # Add to processing queue for full processing
            PREDICTION_QUEUE.put({
                "audio_path": chunk_path,
                "session_id": session_id
            })
            return jsonify({
                "status": "processing",
                "session_id": session_id
            })
        else:
            # For regular chunks, do lightweight processing
            # This would be used for streaming transcription
            return jsonify({
                "status": "received",
                "session_id": session_id,
                "chunk_index": chunk_index
            })
        
    except Exception as e:
        logger.exception("Streaming error")
        return jsonify({"error": str(e)}), 500

@app.route('/api/share', methods=['POST'])
def share_transcription():
    """Share transcription to external platforms"""
    try:
        data = request.json
        platform = data.get('platform')
        content = data.get('content')
        transcription_id = data.get('transcription_id')
        
        if not all([platform, content]):
            return jsonify({'error': 'Missing required fields'}), 400
            
        # Handle different sharing platforms
        if platform == 'telegram':
            # Implementation for Telegram sharing
            return jsonify({'status': 'success', 'message': 'Shared to Telegram'})
        elif platform == 'whatsapp':
            # Implementation for WhatsApp sharing
            return jsonify({'status': 'success', 'message': 'Shared to WhatsApp'})
        elif platform == 'twitter':
            # Implementation for Twitter/X sharing
            return jsonify({'status': 'success', 'message': 'Shared to X'})
        else:
            return jsonify({'error': f'Unsupported platform: {platform}'}), 400
            
    except Exception as e:
        logger.exception("Sharing error")
        return jsonify({"error": str(e)}), 500

@socketio.on('connect')
def handle_connect():
    logger.info(f"Client connected: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"Client disconnected: {request.sid}")

@socketio.on('stream_audio')
def handle_streaming_audio(data):
    """Handle real-time audio streaming via websockets"""
    try:
        # Extract data from the message
        audio_base64 = data.get('audio')  # This should be base64 encoded
        session_id = data.get('session_id', str(uuid.uuid4()))
        is_final = data.get('is_final', False)
        
        if not audio_base64:
            logger.error("No audio data received in websocket message")
            return
            
        try:
            # Decode base64 audio
            audio_bytes = base64.b64decode(audio_base64)
            
            # Save to temporary file
            temp_file = os.path.join(UPLOAD_FOLDER, f"{session_id}_websocket_chunk.wav")
            with open(temp_file, 'wb') as f:
                f.write(audio_bytes)
                
            if is_final:
                # Process the complete audio session
                logger.info(f"Processing final audio chunk for session {session_id}")
                PREDICTION_QUEUE.put({
                    "audio_path": temp_file,
                    "session_id": session_id
                })
                
                # Send acknowledgment
                emit('chunk_received', {
                    'session_id': session_id,
                    'status': 'processing_final'
                })
            else:
                # For streaming, just acknowledge receipt
                emit('chunk_received', {
                    'session_id': session_id,
                    'status': 'received'
                })
        except Exception as e:
            logger.error(f"Error processing audio from websocket: {e}")
            emit('error', {'message': 'Failed to process audio data'})
            
    except Exception as e:
        logger.exception(f"Streaming socket error: {e}")
        emit('error', {'message': 'Internal server error'})

@app.route('/health', methods=['GET'])
def health_check():
    """Simple server status check"""
    model_status = {
        "asr_model": "loaded" if asr_model is not None else "loading",
        "tts_model": "loaded" if tts_model is not None else "loading",
        "noise_reduction": "loaded" if noise_reduction_model is not None else "loading",
    }
    
    queue_size = PREDICTION_QUEUE.qsize()
    
    return jsonify({
        'status': 'ok',
        'timestamp': datetime.datetime.utcnow().isoformat(),
        'upload_folder': os.path.exists(UPLOAD_FOLDER),
        'models': model_status,
        'queue_size': queue_size
    })

if __name__ == '__main__':
    logger.info("Starting Flask-SocketIO server...")
    try:
        socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)
    except Exception as e:
        logger.error(f"Failed to start server: {e}")
