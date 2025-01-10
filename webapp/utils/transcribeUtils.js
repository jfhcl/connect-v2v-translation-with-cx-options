// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { Buffer } from "buffer";
import MicrophoneStream from "microphone-stream";
import { TRANSCRIBE_SAMPLE_RATE_AGENT, TRANSCRIBE_SAMPLE_RATE_CUSTOMER } from "../constants";

export async function checkMediaTrackSettings(stream) {
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    const settings = audioTrack.getSettings();
    return settings.sampleRate; // This will show the actual sample rate of the input device
  }
  return null;
}

export function encodePCMChunk(chunk) {
  const input = MicrophoneStream.toRaw(chunk);
  let offset = 0;
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return Buffer.from(buffer);
}

//Creates Agent Mic Stream, used as input for Amazon Transcribe when transcribing agent's voice
export async function createMicrophoneStream(selectedMic) {
  const micStream = new MicrophoneStream();
  micStream.setStream(
    await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: selectedMic },
    })
  );
  return micStream;
}

export const getTranscribeMicStream = async function* (amazonTranscribeMicStream) {
  for await (const chunk of amazonTranscribeMicStream) {
    if (chunk.length <= TRANSCRIBE_SAMPLE_RATE_AGENT) {
      const encodedChunk = encodePCMChunk(chunk);
      yield {
        AudioEvent: {
          AudioChunk: encodedChunk,
        },
      };
    }
  }
};

export const getTranscribeAudioStream = async function* (amazonTranscribeAudioStream) {
  for await (const chunk of amazonTranscribeAudioStream) {
    if (chunk.length <= TRANSCRIBE_SAMPLE_RATE_CUSTOMER) {
      const encodedChunk = encodePCMChunk(chunk);
      yield {
        AudioEvent: {
          AudioChunk: encodedChunk,
        },
      };
    }
  }
};
