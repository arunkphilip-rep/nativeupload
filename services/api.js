import axios from 'axios';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';

const API_URL = Platform.OS === 'android' ? 
  'http://192.168.1.5:5000' :  // Update with your IP
  'http://localhost:5000';

export const uploadAudio = async (uri) => {
  try {
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
      timeout: 300000
    });

    console.log('Server response:', response.data);
    
    const colabResponse = response.data.colab_response;
    if (!colabResponse?.transcription) {
      throw new Error('No transcription received');
    }

    // Transform response to match expected format
    return {
      ...response.data,
      colab_response: {
        ...colabResponse,
        sentences: [colabResponse.transcription], // Wrap transcription in array
        tts_audio_url: colabResponse.tts_audio_url,
        processing_time: 0 // Default if not provided
      }
    };

  } catch (error) {
    console.error('Upload error:', error);
    throw error;
  }
};
