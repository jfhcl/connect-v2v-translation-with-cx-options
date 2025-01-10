// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { TranscribeStreamingClient } from "@aws-sdk/client-transcribe-streaming";
import { TRANSCRIBE_CONFIG } from "../config";
import { LOGGER_PREFIX } from "../constants";
import { getValidAwsCredentials, hasValidAwsCredentials } from "../utils/authUtility";

let _amazonTranscribeClientAgent;
let _amazonTranscribeClientCustomer;

export async function getAmazonTranscribeClientAgent() {
  try {
    if (_amazonTranscribeClientAgent != null && hasValidAwsCredentials()) {
      // console.info(
      //   `${LOGGER_PREFIX} - getAmazonTranscribeClientAgent - Reusing existing Transcribe client`
      // );
      return _amazonTranscribeClientAgent;
    }

    // Initialize AWS services with credentials
    const credentials = await getValidAwsCredentials();
    _amazonTranscribeClientAgent = new TranscribeStreamingClient({
      region: TRANSCRIBE_CONFIG.transcribeRegion,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });

    // console.info(
    //   `${LOGGER_PREFIX} - getAmazonTranscribeClientAgent - Created new Transcribe client`
    // );
    return _amazonTranscribeClientAgent;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - initializeAwsServices - Error initializing AWS services:`, error);
    throw error;
  }
}

export async function getAmazonTranscribeClientCustomer() {
  try {
    if (_amazonTranscribeClientCustomer != null && hasValidAwsCredentials()) {
      // console.info(
      //   `${LOGGER_PREFIX} - getAmazonTranscribeClientCustomer - Reusing existing Transcribe client`
      // );
      return _amazonTranscribeClientCustomer;
    }

    // Initialize AWS services with credentials
    const credentials = await getValidAwsCredentials();
    _amazonTranscribeClientCustomer = new TranscribeStreamingClient({
      region: TRANSCRIBE_CONFIG.transcribeRegion,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });

    // console.info(
    //   `${LOGGER_PREFIX} - getAmazonTranscribeClientCustomer - Created new Transcribe client`
    // );
    return _amazonTranscribeClientCustomer;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - initializeAwsServices - Error initializing AWS services:`, error);
    throw error;
  }
}
