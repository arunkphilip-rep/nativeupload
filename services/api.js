import axios from 'axios';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';

// API URL configuration based on platform
export const API_URL = Platform.OS === 'android' ? 
  'http://192.168.1.5:5000' :  // Update with your IP for Android testing
  'http://localhost:5000';     // Default for iOS simulator and web

/**
 * Upload a complete audio file for processing
 * @param {string} uri - Local file URI of the audio to upload
 * @param {Function} progressCallback - Optional callback for upload progress
 * @returns {Promise} - Promise with the server response
 */
export const uploadAudio = async (uri, progressCallback = () => {}) => {
  try {
    console.log(`Uploading audio from ${uri}`);
    const formData = new FormData();
    formData.append('file', {
      uri: Platform.OS === 'ios' ? uri.replace('file://', '') : uri,
      type: 'audio/*',
      name: `audio-${Date.now()}.${uri.split('.').pop()}`
    });

    const response = await axios.post(`${API_URL}/api/upload`, formData, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'multipart/form-data'
      },
      timeout: 300000,
      onUploadProgress: (progressEvent) => {
        const percentCompleted = Math.round(
          (progressEvent.loaded * 100) / progressEvent.total
        );
        progressCallback(percentCompleted);
      }
    });

    console.log('Server response:', response.data);
    
    // Return standardized response
    return {
      ...response.data,
      colab_response: response.data.colab_response || {
        transcription: "", 
        tts_audio_url: ""
      }
    };

  } catch (error) {
    console.error('Upload error:', error);
    throw error;
  }
};

/**
 * Stream an audio chunk for real-time processing
 * @param {string} uri - Local file URI of the audio chunk
 * @param {string} sessionId - Session identifier for this recording
 * @param {number} chunkIndex - Index of this chunk in the stream
 * @param {boolean} isFinal - Whether this is the final chunk
 * @returns {Promise} - Promise with the server response
 */
export const streamAudioChunk = async (uri, sessionId, chunkIndex = 0, isFinal = false) => {
  try {
    const formData = new FormData();
    formData.append('audio', {
      uri: Platform.OS === 'ios' ? uri.replace('file://', '') : uri,
      type: 'audio/*',
      name: `chunk-${chunkIndex}.wav`
    });
    formData.append('session_id', sessionId);
    formData.append('chunk_index', chunkIndex.toString());
    formData.append('is_final', isFinal.toString());

    const response = await axios.post(`${API_URL}/api/stream`, formData, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'multipart/form-data'
      },
      timeout: isFinal ? 60000 : 10000 // Longer timeout for final chunk
    });

    return response.data;
  } catch (error) {
    console.error('Stream error:', error);
    throw error;
  }
};

/**
 * Get transcription results for a session
 * @param {string} sessionId - Session identifier
 * @returns {Promise} - Promise with the transcription results
 */
export const getTranscriptionResult = async (sessionId) => {
  try {
    const response = await axios.get(`${API_URL}/api/transcription/${sessionId}`, {
      headers: {
        'Accept': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Get transcription error:', error);
    throw error;
  }
};

/**
 * Share transcription to a specific platform
 * @param {string} platform - Platform to share to (telegram, whatsapp, twitter)
 * @param {string} content - Text content to share
 * @param {string} transcriptionId - ID of the transcription
 * @returns {Promise} - Promise with the sharing result
 */
export const shareTranscription = async (platform, content, transcriptionId) => {
  try {
    const response = await axios.post(`${API_URL}/api/share`, {
      platform,
      content,
      transcription_id: transcriptionId
    }, {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Share error:', error);
    throw error;
  }
};

/**
 * Health check for the server API
 * @returns {Promise} - Promise with the server health status
 */
export const checkServerHealth = async () => {
  try {
    const response = await axios.get(`${API_URL}/health`, {
      timeout: 5000
    });
    return response.data;
  } catch (error) {
    console.error('Health check error:', error);
    throw error;
  }
};
