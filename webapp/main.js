// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import "./style.css";
import "amazon-connect-streams";
import { StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";

import MicrophoneStream from "microphone-stream";

import { getConnectURLS, addUpdateLocalStorageKey, getLocalStorageValueByKey, base64ToArrayBuffer, isStringUndefinedNullEmpty } from "./utils/commonUtility";
import {
  AGENT_TRANSLATION_TO_AGENT_VOLUME,
  CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME,
  LOGGER_PREFIX,
  POLLY_ENGINES,
  POLLY_LANGUAGE_CODES,
  TRANSCRIBE_SAMPLE_RATE_AGENT,
  TRANSCRIBE_SAMPLE_RATE_CUSTOMER,
  TRANSCRIBE_STREAMING_LANGUAGES,
} from "./constants";
import { getLoginUrl, getValidTokens, handleRedirect, isAuthenticated, logout, setRedirectURI, startTokenRefreshTimer } from "./utils/authUtility";
import { AudioStreamManager } from "./managers/AudioStreamManager";
import { SessionTrackManager, TrackType } from "./managers/SessionTrackManager";
import { createMicrophoneStream, getTranscribeAudioStream, getTranscribeMicStream } from "./utils/transcribeUtils";
import { listLanguages, translateText } from "./adapters/translateAdapter";
import { describeVoices, synthesizeSpeech } from "./adapters/pollyAdapter";
import { CONNECT_CONFIG } from "./config";
import { getAmazonTranscribeClientAgent, getAmazonTranscribeClientCustomer } from "./adapters/transcribeAdapter";

let connect = {};
let CurrentUser = {};
let CCP_V2V = {};

let CurrentAgentConnectionId;
let ConnectSoftPhoneManager;
let IsAgentTranscriptionMuted = false;

//Agent Mic Stream used as input for Amazon Transcribe when transcribing agent's voice
let AmazonTranscribeToCustomerStream;
//Customer Speaker Stream used as input for Amazon Transcribe when transcribing customer's voice
let AmazonTranscribeFromCustomerAudioStream;

// SessionTrackManager to manage the current track streaming to the customer
let RTCSessionTrackManager;

// AudioStreamManager to manage the stream that goes to Customer
let ToCustomerAudioStreamManager;

// AudioStreamManager to manage the stream that goes to Agent
let ToAgentAudioStreamManager;

async function replaceRTCSessionTrackManager(peerConnection) {
  if (RTCSessionTrackManager != null) {
    await RTCSessionTrackManager.dispose();
  }
  RTCSessionTrackManager = new SessionTrackManager(peerConnection);
}

async function replaceToCustomerAudioStreamManager() {
  if (ToCustomerAudioStreamManager != null) {
    await ToCustomerAudioStreamManager.dispose();
  }
  ToCustomerAudioStreamManager = new AudioStreamManager(CCP_V2V.UI.toCustomerAudioElement);
}

async function replaceToAgentAudioStreamManager() {
  if (ToAgentAudioStreamManager != null) {
    await ToAgentAudioStreamManager.dispose();
  }
  ToAgentAudioStreamManager = new AudioStreamManager(CCP_V2V.UI.toAgentAudioElement);
}

window.addEventListener("load", () => {
  initializeApp();
});

async function initializeApp() {
  try {
    console.info(`${LOGGER_PREFIX} - initializeApp - Initializing app`);
    setRedirectURI();
    // Check if we're returning from Cognito login
    const isRedirect = await handleRedirect();
    if (isRedirect) {
      console.info(`${LOGGER_PREFIX} - initializeApp - Redirected from Cognito login`);
      showApp();
      return;
    }

    // Check authentication and token expiration
    if (!isAuthenticated()) {
      const tokens = await getValidTokens();
      if (tokens?.accessToken == null || tokens?.idToken == null || tokens?.refreshToken == null) {
        // No valid token available, redirect to login
        console.info(`${LOGGER_PREFIX} - initializeApp - No valid token available, redirecting to login`);
        window.location.href = getLoginUrl();
        return;
      }
    }

    // Show app with valid token
    console.info(`${LOGGER_PREFIX} - initializeApp - Valid token available, showing app`);
    startTokenRefreshTimer();
    showApp();
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - initializeApp - Error initializing app:`, error);
    window.location.href = getLoginUrl();
  }
}

function showApp() {
  onLoad();
}

const onLoad = async () => {
  console.info(`${LOGGER_PREFIX} - index loaded`);
  bindUIElements();
  initEventListeners();
  CCP_V2V.UI.logoutButton.style.display = "block";
  getDevices();
  setAudioElementsSinkIds();
  loadTranscribeLanguageCodes();
  loadTranslateLanguageCodes();
  loadPollyEngines();
  loadPollyLanguageCodes();
  loadCustomerPollyVoiceIds().then(loadAgentPollyVoiceIds);
  initCCP(onConnectInitialized);
};

const bindUIElements = () => {
  window.connect.CCP_V2V = CCP_V2V;

  CCP_V2V.UI = {
    logoutButton: document.getElementById("logoutButton"),
    divInstanceSetup: document.getElementById("divInstanceSetup"),
    divMain: document.getElementById("divMain"),

    ccpContainer: document.querySelector("#ccpContainer"),

    spnCurrentConnectInstanceURL: document.getElementById("spnCurrentConnectInstanceURL"),
    tbConnectInstanceURL: document.getElementById("tbConnectInstanceURL"),
    btnSetConnectInstanceURL: document.getElementById("btnSetConnectInstanceURL"),
    btnStreamFile: document.getElementById("btnStreamFile"),
    btnStreamMic: document.getElementById("btnStreamMic"),
    btnRemoveAudioStream: document.getElementById("btnRemoveAudioStream"),

    //mic & speaker UI elements
    micSelect: document.getElementById("micSelect"),
    speakerSelect: document.getElementById("speakerSelect"),

    fromCustomerAudioElement: document.getElementById("remote-audio"),
    toCustomerAudioElement: document.getElementById("toCustomerAudioElement"),
    toAgentAudioElement: document.getElementById("toAgentAudioElement"),

    testAudioButton: document.getElementById("testAudioButton"),
    testMicButton: document.getElementById("testMicButton"),
    speakerSaveButton: document.getElementById("speakerSaveButton"),
    micSaveButton: document.getElementById("micSaveButton"),

    //Transcribe Customer UI Elements
    customerTranscribeLanguageSelect: document.getElementById("customerTranscribeLanguageSelect"),
    customerTranscribeLanguageSaveButton: document.getElementById("customerTranscribeLanguageSaveButton"),
    customerStartTranscriptionButton: document.getElementById("customerStartTranscriptionButton"),
    customerStopTranscriptionButton: document.getElementById("customerStopTranscriptionButton"),
    customerTranscriptionTextOutputDiv: document.getElementById("customerTranscriptionTextOutputDiv"),
    customerStreamMicCheckbox: document.getElementById("customerStreamMicCheckbox"),
    customerStreamTranslationCheckbox: document.getElementById("customerStreamTranslationCheckbox"),
    //Translate Customer UI Elements
    customerTranslateFromLanguageSelect: document.getElementById("customerTranslateFromLanguageSelect"),
    customerTranslateToLanguageSelect: document.getElementById("customerTranslateToLanguageSelect"),
    customerTranslateFromLanguageSaveButton: document.getElementById("customerTranslateFromLanguageSaveButton"),
    customerTranslateToLanguageSaveButton: document.getElementById("customerTranslateToLanguageSaveButton"),
    customerTranslatedTextOutputDiv: document.getElementById("customerTranslatedTextOutputDiv"),
    //Polly Customer UI Elements
    customerPollyLanguageCodeSelect: document.getElementById("customerPollyLanguageCodeSelect"),
    customerPollyLanguageCodeSaveButton: document.getElementById("customerPollyLanguageCodeSaveButton"),
    customerPollyEngineSelect: document.getElementById("customerPollyEngineSelect"),
    customerPollyEngineSaveButton: document.getElementById("customerPollyEngineSaveButton"),
    customerPollyVoiceIdSelect: document.getElementById("customerPollyVoiceIdSelect"),
    customerPollyVoiceIdSaveButton: document.getElementById("customerPollyVoiceIdSaveButton"),

    //Transcribe Agent UI Elements
    agentTranscribeLanguageSelect: document.getElementById("agentTranscribeLanguageSelect"),
    agentTranscribeLanguageSaveButton: document.getElementById("agentTranscribeLanguageSaveButton"),
    agentStartTranscriptionButton: document.getElementById("agentStartTranscriptionButton"),
    agentStopTranscriptionButton: document.getElementById("agentStopTranscriptionButton"),
    agentMuteTranscriptionButton: document.getElementById("agentMuteTranscriptionButton"),
    agentTranscriptionTextOutputDiv: document.getElementById("agentTranscriptionTextOutputDiv"),
    agentAudioFeedbackEnabledCheckbox: document.getElementById("agentAudioFeedbackEnabledCheckbox"),
    agentStreamMicCheckbox: document.getElementById("agentStreamMicCheckbox"),
    agentStreamMicVolume: document.getElementById("agentStreamMicVolume"),
    agentStreamTranslationCheckbox: document.getElementById("agentStreamTranslationCheckbox"),
    //Translate Agent UI Elements
    agentTranslateFromLanguageSelect: document.getElementById("agentTranslateFromLanguageSelect"),
    agentTranslateToLanguageSelect: document.getElementById("agentTranslateToLanguageSelect"),
    agentTranslateFromLanguageSaveButton: document.getElementById("agentTranslateFromLanguageSaveButton"),
    agentTranslateToLanguageSaveButton: document.getElementById("agentTranslateToLanguageSaveButton"),
    agentTranslateTextInput: document.getElementById("agentTranslateTextInput"),
    agentTranslateTextButton: document.getElementById("agentTranslateTextButton"),
    agentTranslatedTextOutputDiv: document.getElementById("agentTranslatedTextOutputDiv"),
    //Polly Agent UI Elements
    agentPollyLanguageCodeSelect: document.getElementById("agentPollyLanguageCodeSelect"),
    agentPollyLanguageCodeSaveButton: document.getElementById("agentPollyLanguageCodeSaveButton"),
    agentPollyEngineSelect: document.getElementById("agentPollyEngineSelect"),
    agentPollyEngineSaveButton: document.getElementById("agentPollyEngineSaveButton"),
    agentPollyVoiceIdSelect: document.getElementById("agentPollyVoiceIdSelect"),
    agentPollyVoiceIdSaveButton: document.getElementById("agentPollyVoiceIdSaveButton"),
    agentPollyTextInput: document.getElementById("agentPollyTextInput"),
    agentSynthesizeSpeechButton: document.getElementById("agentSynthesizeSpeechButton"),
  };
};

const initEventListeners = () => {
  CCP_V2V.UI.logoutButton.addEventListener("click", logout);

  CCP_V2V.UI.btnStreamFile.addEventListener("click", streamFile);
  CCP_V2V.UI.btnStreamMic.addEventListener("click", streamMic);
  CCP_V2V.UI.btnRemoveAudioStream.addEventListener("click", removeAudioTrack);

  //mic & speaker ui buttons
  CCP_V2V.UI.testAudioButton.addEventListener("click", testAudioOutput);
  CCP_V2V.UI.testMicButton.addEventListener("click", testMicrophone);
  CCP_V2V.UI.speakerSaveButton.addEventListener("click", () => addUpdateLocalStorageKey("selectedSpeakerId", CCP_V2V.UI.speakerSelect.value));
  CCP_V2V.UI.micSaveButton.addEventListener("click", () => addUpdateLocalStorageKey("selectedMicId", CCP_V2V.UI.micSelect.value));

  //Transcribe Customer UI buttons
  CCP_V2V.UI.customerTranscribeLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerTranscribeLanguage", CCP_V2V.UI.customerTranscribeLanguageSelect.value);
  });
  CCP_V2V.UI.customerStartTranscriptionButton.addEventListener("click", customerStartTranscription);
  CCP_V2V.UI.customerStopTranscriptionButton.addEventListener("click", customerStopTranscription);

  CCP_V2V.UI.customerStreamMicCheckbox.addEventListener("change", (event) => {
    if (event.target.checked) {
      CCP_V2V.UI.fromCustomerAudioElement.muted = false;
    } else {
      CCP_V2V.UI.fromCustomerAudioElement.muted = true;
    }
  });

  //Translate Customer UI buttons
  CCP_V2V.UI.customerTranslateFromLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerTranslateFromLanguage", CCP_V2V.UI.customerTranslateFromLanguageSelect.value);
  });
  CCP_V2V.UI.customerTranslateToLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerTranslateToLanguage", CCP_V2V.UI.customerTranslateToLanguageSelect.value);
  });
  //Polly Customer UI buttons
  CCP_V2V.UI.customerPollyLanguageCodeSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerPollyLanguageCode", CCP_V2V.UI.customerPollyLanguageCodeSelect.value);
  });
  CCP_V2V.UI.customerPollyEngineSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerPollyEngine", CCP_V2V.UI.customerPollyEngineSelect.value);
  });
  CCP_V2V.UI.customerPollyVoiceIdSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("customerPollyVoiceId", CCP_V2V.UI.customerPollyVoiceIdSelect.value);
  });
  CCP_V2V.UI.customerPollyLanguageCodeSelect.addEventListener("change", loadCustomerPollyVoiceIds);
  CCP_V2V.UI.customerPollyEngineSelect.addEventListener("change", loadCustomerPollyVoiceIds);

  //Transcribe Agent UI buttons
  CCP_V2V.UI.agentTranscribeLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentTranscribeLanguage", CCP_V2V.UI.agentTranscribeLanguageSelect.value);
  });

  CCP_V2V.UI.agentStartTranscriptionButton.addEventListener("click", agentStartTranscription);

  CCP_V2V.UI.agentStopTranscriptionButton.addEventListener("click", agentStopTranscription);

  CCP_V2V.UI.agentMuteTranscriptionButton.addEventListener("click", () => {
    CCP_V2V.UI.agentMuteTranscriptionButton.textContent = IsAgentTranscriptionMuted ? "Unmute" : "Mute";
    toggleAgentTranscriptionMute();
  });

  CCP_V2V.UI.agentAudioFeedbackEnabledCheckbox.addEventListener("change", (event) => {
    if (event.target.checked) {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.enableAudioFeedback();
    } else {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.disableAudioFeedback();
    }
  });

  CCP_V2V.UI.agentStreamMicCheckbox.addEventListener("change", (event) => {
    const selectedMic = CCP_V2V.UI.micSelect.value;
    if (event.target.checked) {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.startMicrophone(selectedMic);
    } else {
      if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.stopMicrophone();
    }
  });

  CCP_V2V.UI.agentStreamMicVolume.addEventListener("input", (event) => {
    const micVolume = parseFloat(event.target.value);
    if (ToCustomerAudioStreamManager != null) ToCustomerAudioStreamManager.setMicrophoneVolume(micVolume);
  });

  //Translate Agent UI buttons
  CCP_V2V.UI.agentTranslateFromLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentTranslateFromLanguage", CCP_V2V.UI.agentTranslateFromLanguageSelect.value);
  });
  CCP_V2V.UI.agentTranslateToLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentTranslateToLanguage", CCP_V2V.UI.agentTranslateToLanguageSelect.value);
  });
  CCP_V2V.UI.agentTranslateToLanguageSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentTranslateToLanguage", CCP_V2V.UI.agentTranslateToLanguageSelect.value);
  });
  CCP_V2V.UI.agentTranslateTextButton.addEventListener("click", handleAgentTranslateText);
  CCP_V2V.UI.agentTranslateTextInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      handleAgentTranslateText();
    }
  });
  //Polly Agent UI buttons
  CCP_V2V.UI.agentPollyLanguageCodeSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentPollyLanguageCode", CCP_V2V.UI.agentPollyLanguageCodeSelect.value);
  });
  CCP_V2V.UI.agentPollyEngineSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentPollyEngine", CCP_V2V.UI.agentPollyEngineSelect.value);
  });
  CCP_V2V.UI.agentPollyVoiceIdSaveButton.addEventListener("click", () => {
    addUpdateLocalStorageKey("agentPollyVoiceId", CCP_V2V.UI.agentPollyVoiceIdSelect.value);
  });
  CCP_V2V.UI.agentPollyLanguageCodeSelect.addEventListener("change", loadAgentPollyVoiceIds);
  CCP_V2V.UI.agentPollyEngineSelect.addEventListener("change", loadAgentPollyVoiceIds);
  CCP_V2V.UI.agentSynthesizeSpeechButton.addEventListener("click", handleAgentSynthesizeSpeech);
  CCP_V2V.UI.agentPollyTextInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      handleAgentSynthesizeSpeech();
    }
  });
};

const initCCP = async (onConnectInitialized) => {
  const { connectCCPURL } = getConnectURLS();
  if (!window.connect.core.initialized) {
    console.info(`${LOGGER_PREFIX} -  Amazon Connect CCP initialization started`);
    window.connect.core.initCCP(CCP_V2V.UI.ccpContainer, {
      ccpUrl: connectCCPURL,
      loginPopup: true,
      loginPopupAutoClose: true,
      loginOptions: {
        // optional, if provided opens login in new window
        autoClose: true, // optional, defaults to `false`
        height: 600, // optional, defaults to 578
        width: 400, // optional, defaults to 433
        top: 0, // optional, defaults to 0
        left: 0, // optional, defaults to 0
      },
      region: CONNECT_CONFIG.connectInstanceRegion,
      softphone: {
        allowFramedSoftphone: false, //we don't want the default softphone
        allowFramedVideoCall: true, //allow the agent to add video to the call
        disableRingtone: false,
      },
    });

    window.connect.agent((agent) => {
      console.info(`${LOGGER_PREFIX} -  Amazon Connect CCP initialization completed`);
      if (onConnectInitialized) onConnectInitialized(agent);
    });
  } else {
    console.info(`${LOGGER_PREFIX} - Amazon Connect CCP Already Initialized`);
  }
};

const onConnectInitialized = (connectAgent) => {
  connect = window.connect;
  connect.core.initSoftphoneManager({ allowFramedSoftphone: true });

  const connectAgentConfiguration = connectAgent.getConfiguration();
  CurrentUser["currentUser_ConnectUsername"] = connectAgentConfiguration.username;

  subscribeToAgentEvents();
  subscribeToContactEvents();

  connect.core.onSoftphoneSessionInit(function ({ connectionId }) {
    ConnectSoftPhoneManager = connect.core.getSoftphoneManager();
    //console.info(`${LOGGER_PREFIX} - softphoneManager`, softphoneManager);
  });
};

function subscribeToAgentEvents() {
  // Subscribe to Agent Events from Streams API, and handle Agent events with functions defined above
  console.info(`${LOGGER_PREFIX} - subscribing to events for agent`);

  connect.agent((agent) => {
    agent.onLocalMediaStreamCreated(onAgentLocalMediaStreamCreated);
    // agent.onStateChange(agentStateChange);
    // agent.onRefresh(agentRefresh);
    // agent.onOffline(agentOffline);
  });
}

function subscribeToContactEvents() {
  // Subscribe to Contact Events from Streams API, and handle Contact events
  console.info(`${LOGGER_PREFIX} - subscribing to events for contact`);
  connect.contact((contact) => {
    console.info(`${LOGGER_PREFIX} - new contact`, contact);
    if (contact.getActiveInitialConnection() && contact.getActiveInitialConnection().getEndpoint()) {
      console.info(`${LOGGER_PREFIX} - new contact is from ${contact.getActiveInitialConnection().getEndpoint().phoneNumber}`);
    } else {
      console.info(`${LOGGER_PREFIX} - this is an existing contact for this agent`);
    }

    contact.onConnecting(onContactConnecting);
    contact.onConnected(onContactConnected);
    contact.onEnded(onContactEnded);
    // contact.onRefresh(contactRefreshed);
  });
}

function onContactConnecting(contact) {
  console.info(`${LOGGER_PREFIX} - contact is connecting`, contact);
}

function onContactConnected(contact) {
  console.info(`${LOGGER_PREFIX} - contact connected`, contact);
}

function onContactEnded(contact) {
  console.info(`${LOGGER_PREFIX} - contact has ended`, contact);
  CurrentAgentConnectionId = null;
  if (ToCustomerAudioStreamManager != null) {
    ToCustomerAudioStreamManager.dispose();
    ToCustomerAudioStreamManager = null;
  }
  if (ToAgentAudioStreamManager != null) {
    ToAgentAudioStreamManager.dispose();
    ToAgentAudioStreamManager = null;
  }
  if (RTCSessionTrackManager != null) {
    RTCSessionTrackManager.dispose();
    RTCSessionTrackManager = null;
  }
  customerStopTranscription();
  agentStopTranscription();
  cleanUpUI();
}

function onAgentLocalMediaStreamCreated(data) {
  //console.info(`${LOGGER_PREFIX} - onAgentLocalMediaStreamCreated`, data);
  CurrentAgentConnectionId = data.connectionId;
  const session = ConnectSoftPhoneManager?.getSession(CurrentAgentConnectionId);
  const peerConnection = session?._pc;
  replaceToCustomerAudioStreamManager();
  replaceToAgentAudioStreamManager();
  replaceRTCSessionTrackManager(peerConnection);
}

function setAudioElementsSinkIds() {
  CCP_V2V.UI.fromCustomerAudioElement.setSinkId(CCP_V2V.UI.speakerSelect.value);
  CCP_V2V.UI.toCustomerAudioElement.setSinkId(CCP_V2V.UI.speakerSelect.value);
  CCP_V2V.UI.toAgentAudioElement.setSinkId(CCP_V2V.UI.speakerSelect.value);
}

//Instead of streaming Microphone, stream an Audio File
function streamFile() {
  try {
    const fileStreamAudioTrack = RTCSessionTrackManager.createFileTrack("./assets/speech_20241113001759828.mp3");
    //console.info(`${LOGGER_PREFIX} - streamFile`, fileStreamAudioTrack);
    RTCSessionTrackManager.replaceTrack(fileStreamAudioTrack, TrackType.FILE);
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - streamFile`, error);
    raiseError(`Error steaming file: ${error}`);
  }
}

//Instead of streaming File, stream Mic
async function streamMic() {
  const selectedMic = CCP_V2V.UI.micSelect.value;
  if (!selectedMic) {
    raiseError("Please select a microphone!");
    return;
  }

  const micStreamAudioTrack = await RTCSessionTrackManager.createMicTrack(selectedMic);
  //console.info(`${LOGGER_PREFIX} - streamMic`, micStreamAudioTrack);
  RTCSessionTrackManager.replaceTrack(micStreamAudioTrack, TrackType.MIC);
}

//Instead of removing AudioTrack, stream a silent AudioTrack
async function removeAudioTrack() {
  const silentTrack = RTCSessionTrackManager.createSilentTrack();
  // console.info(
  //   `${LOGGER_PREFIX} - removeAudioTrack - replacing with a silent track`
  // );
  RTCSessionTrackManager.replaceTrack(silentTrack, TrackType.SILENT);
}

async function testMicrophone() {
  const selectedMic = CCP_V2V.UI.micSelect.value;

  if (!selectedMic) {
    raiseError("Please select a microphone!");
    return;
  }

  try {
    // Request access to the selected microphone
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: selectedMic },
    });

    // Get the audio context and create an analyser to visualize the audio input
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const microphoneStreamSource = audioContext.createMediaStreamSource(micStream);
    microphoneStreamSource.connect(analyser);

    // Setup the analyser
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // Function to update the volume bar based on microphone input
    function updateVolume() {
      analyser.getByteFrequencyData(dataArray);

      // Calculate average volume
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;

      // Update the volume level bar
      const volumeBar = document.getElementById("volumeBar");
      const volumePercentage = Math.min((average / 255) * 100, 100);
      volumeBar.style.width = `${volumePercentage}%`;

      requestAnimationFrame(updateVolume);
    }

    // Start updating the volume bar
    updateVolume();

    // Play the stream through the audio element (optional for audio feedback)
    // const audioPlayback = document.getElementById("audioPlayback");
    // audioPlayback.srcObject = stream;
    // audioPlayback.play();
  } catch (err) {
    console.error(`${LOGGER_PREFIX} - testMicrophone - Error accessing microphone`, err);
    raiseError("Failed to access microphone.");
  }
}

// Function to test the selected audio output device
function testAudioOutput() {
  const selectedSpeaker = CCP_V2V.UI.speakerSelect.value;
  if (!selectedSpeaker) {
    raiseError("Please select a speaker!");
    return;
  }

  // Create an audio context and set the output device using setSinkId()
  const audio = new Audio("/assets/chime-sound-7143.mp3");
  audio
    .setSinkId(selectedSpeaker)
    .then(() => {
      console.info(`${LOGGER_PREFIX} - testAudioOutput - Audio output device set successfully`);
      audio.play();
    })
    .catch((err) => {
      console.error(`${LOGGER_PREFIX} - testAudioOutput - Error setting output device:`, err);
      raiseError("Failed to set audio output device.");
    });
}

async function getDevices() {
  try {
    //check Microphone permission
    const micPermission = await navigator.permissions.query({ name: "microphone" });
    if (micPermission.state === "denied") {
      raiseError("Microphone permission is denied. Please allow microphone access in your browser settings.");
      return;
    }

    // Get all media devices (input and output)
    const devices = await navigator.mediaDevices.enumerateDevices();

    // Arrays to store cam, mic and speaker devices
    const micDevices = [];
    const speakerDevices = [];

    // Loop through devices and filter by kind
    devices.forEach((device) => {
      if (device.kind === "audioinput") {
        micDevices.push(device);
      } else if (device.kind === "audiooutput") {
        speakerDevices.push(device);
      }
    });

    // Populate the microphone dropdown
    micDevices.forEach((mic) => {
      const option = document.createElement("option");
      option.value = mic.deviceId;
      option.textContent = mic.label || `Microphone ${mic.deviceId}`;
      CCP_V2V.UI.micSelect.appendChild(option);
    });

    //pre-select the Default mic
    const defaultMic = micDevices.find((mic) => mic.deviceId.startsWith("default"));
    if (defaultMic) {
      CCP_V2V.UI.micSelect.value = defaultMic.deviceId;
    }
    //pre-select the saved mic
    const savedMicId = getLocalStorageValueByKey("selectedMicId");
    if (savedMicId) {
      CCP_V2V.UI.micSelect.value = savedMicId;
    }

    // Populate the speaker dropdown
    speakerDevices.forEach((speaker) => {
      const option = document.createElement("option");
      option.value = speaker.deviceId;
      option.textContent = speaker.label || `Speaker ${speaker.deviceId}`;
      CCP_V2V.UI.speakerSelect.appendChild(option);
    });

    //pre-select the Default speaker
    const defaultSpeaker = speakerDevices.find((speaker) => speaker.deviceId.startsWith("default"));
    if (defaultSpeaker) {
      CCP_V2V.UI.speakerSelect.value = defaultSpeaker.deviceId;
    }
    //pre-select the saved speaker
    const savedSpeakerId = getLocalStorageValueByKey("selectedSpeakerId");
    if (savedSpeakerId) {
      CCP_V2V.UI.speakerSelect.value = savedSpeakerId;
    }
  } catch (err) {
    console.error(`${LOGGER_PREFIX} - getDevices - Error accessing devices:`, err);
  }
}

async function loadTranscribeLanguageCodes() {
  TRANSCRIBE_STREAMING_LANGUAGES.forEach((language) => {
    const option = document.createElement("option");
    option.value = language;
    option.textContent = language;
    CCP_V2V.UI.customerTranscribeLanguageSelect.appendChild(option);
    CCP_V2V.UI.agentTranscribeLanguageSelect.appendChild(option.cloneNode(true));
  });
  //set en-US as default
  CCP_V2V.UI.customerTranscribeLanguageSelect.value = "en-US";
  CCP_V2V.UI.agentTranscribeLanguageSelect.value = "en-US";

  //pre-select saved transcribeLanguage
  const savedCustomerTranscribeLanguage = getLocalStorageValueByKey("customerTranscribeLanguage");
  if (savedCustomerTranscribeLanguage) {
    CCP_V2V.UI.customerTranscribeLanguageSelect.value = savedCustomerTranscribeLanguage;
  }

  const savedAgentTranscribeLanguage = getLocalStorageValueByKey("agentTranscribeLanguage");
  if (savedAgentTranscribeLanguage) {
    CCP_V2V.UI.agentTranscribeLanguageSelect.value = savedAgentTranscribeLanguage;
  }
}

//Creates Customer Speaker Stream used as input for Amazon Transcribe when transcribing customer's voice
async function captureFromCustomerAudioStream() {
  const session = ConnectSoftPhoneManager?.getSession(CurrentAgentConnectionId);
  const audioStream = session._remoteAudioStream;

  const amazonTranscribeFromCustomerAudioStream = new MicrophoneStream();
  amazonTranscribeFromCustomerAudioStream.setStream(audioStream);
  return amazonTranscribeFromCustomerAudioStream;
}

async function customerStartTranscription() {
  try {
    if (CCP_V2V.UI.customerStreamMicCheckbox.checked === true) {
      //we want agent to hear the customer's original voice, so we reduce the fromCustomerAudioElement volume
      CCP_V2V.UI.fromCustomerAudioElement.volume = 0.3;
    } else {
      //we don't want agent to hear the customer's original voice, so we mute the fromCustomerAudioElement
      CCP_V2V.UI.fromCustomerAudioElement.muted = true;
    }

    //Play the audio feedback to customer
    if (CCP_V2V.UI.agentAudioFeedbackEnabledCheckbox.checked === true) {
      ToCustomerAudioStreamManager.enableAudioFeedback("./assets/background_noise.wav");
    }

    //Get ready to stream To Customer
    const toCustomerAudioTrack = ToCustomerAudioStreamManager.getAudioTrack();
    RTCSessionTrackManager.replaceTrack(toCustomerAudioTrack, TrackType.POLLY);

    //getting the remote audio stream from the current RTC session into AmazonTranscribeAudioStream variable
    AmazonTranscribeFromCustomerAudioStream = await captureFromCustomerAudioStream();

    const startStreamTranscriptionCommand = new StartStreamTranscriptionCommand({
      LanguageCode: customerTranscribeLanguageSelect.value,
      MediaEncoding: "pcm",
      MediaSampleRateHertz: TRANSCRIBE_SAMPLE_RATE_CUSTOMER,
      AudioStream: getTranscribeAudioStream(AmazonTranscribeFromCustomerAudioStream),
    });

    const amazonTranscribeClientCustomer = await getAmazonTranscribeClientCustomer();
    const startStreamTranscriptionResponse = await amazonTranscribeClientCustomer.send(startStreamTranscriptionCommand);

    CCP_V2V.UI.customerStartTranscriptionButton.disabled = true;
    CCP_V2V.UI.customerStopTranscriptionButton.disabled = false;

    for await (const event of startStreamTranscriptionResponse.TranscriptResultStream) {
      const results = event.TranscriptEvent.Transcript.Results;
      if (results.length && !results[0]?.IsPartial) {
        const newTranscript = results[0].Alternatives[0].Transcript;
        handleCustomerTranscript(newTranscript);
        //execute CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent after 100ms
        setTimeout(() => {
          CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = newTranscript;
        }, 100);
      }
    }
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - customerStartTranscription - Error starting customer transcription:`, error);
  }
}

async function customerStopTranscription() {
  if (AmazonTranscribeFromCustomerAudioStream) {
    AmazonTranscribeFromCustomerAudioStream.stop();
    AmazonTranscribeFromCustomerAudioStream.destroy();
    AmazonTranscribeFromCustomerAudioStream = undefined;
  }

  //un-mute the audio element
  CCP_V2V.UI.fromCustomerAudioElement.muted = false;

  CCP_V2V.UI.customerStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.customerStopTranscriptionButton.disabled = true;
}

async function agentStartTranscription() {
  try {
    const selectedMic = CCP_V2V.UI.micSelect.value;

    if (CCP_V2V.UI.agentAudioFeedbackEnabledCheckbox.checked === true) {
      ToAgentAudioStreamManager.enableAudioFeedback("./assets/background_noise.wav");
    }

    //Get ready to stream To Customer
    const toCustomerAudioTrack = ToCustomerAudioStreamManager.getAudioTrack();
    RTCSessionTrackManager.replaceTrack(toCustomerAudioTrack, TrackType.POLLY);

    if (CCP_V2V.UI.agentStreamMicCheckbox.checked === true) {
      await ToCustomerAudioStreamManager.startMicrophone(selectedMic);
      const micVolume = parseFloat(CCP_V2V.UI.agentStreamMicVolume.value);
      ToCustomerAudioStreamManager.setMicrophoneVolume(micVolume);
    }

    //getting the local Mic stream into AmazonTranscribeMicStream variable
    AmazonTranscribeToCustomerStream = await createMicrophoneStream(selectedMic);

    const startStreamTranscriptionCommand = new StartStreamTranscriptionCommand({
      LanguageCode: agentTranscribeLanguageSelect.value,
      MediaEncoding: "pcm",
      MediaSampleRateHertz: TRANSCRIBE_SAMPLE_RATE_AGENT,
      AudioStream: getTranscribeMicStream(AmazonTranscribeToCustomerStream),
    });

    const amazonTranscribeClientAgent = await getAmazonTranscribeClientAgent();
    const startStreamTranscriptionResponse = await amazonTranscribeClientAgent.send(startStreamTranscriptionCommand);

    CCP_V2V.UI.agentStartTranscriptionButton.disabled = true;
    CCP_V2V.UI.agentStopTranscriptionButton.disabled = false;

    for await (const event of startStreamTranscriptionResponse.TranscriptResultStream) {
      const results = event.TranscriptEvent.Transcript.Results;
      if (results.length && !results[0]?.IsPartial) {
        const newTranscript = results[0].Alternatives[0].Transcript;
        handleAgentTranscript(newTranscript);
        //execute CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent after 100ms
        setTimeout(() => {
          CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = newTranscript;
        }, 100);
      }
    }
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - agentStartTranscription - Error starting agent transcription:`, error);
  }
}

function agentStopTranscription() {
  if (AmazonTranscribeToCustomerStream) {
    AmazonTranscribeToCustomerStream.stop();
    AmazonTranscribeToCustomerStream.destroy();
    AmazonTranscribeToCustomerStream = undefined;
  }

  CCP_V2V.UI.agentStartTranscriptionButton.disabled = false;
  CCP_V2V.UI.agentStopTranscriptionButton.disabled = true;
}

function toggleAgentTranscriptionMute() {
  if (AmazonTranscribeToCustomerStream) {
    const audioTrack = AmazonTranscribeToCustomerStream.stream.getAudioTracks()[0];
    if (audioTrack) {
      //Disable the track in AmazonTranscribeToCustomerStream
      audioTrack.enabled = !audioTrack.enabled;
      IsAgentTranscriptionMuted = !audioTrack.enabled;
      //Mute the Mic so it is not streamed to Customer
      const selectedMic = CCP_V2V.UI.micSelect.value;
      IsAgentTranscriptionMuted ? ToCustomerAudioStreamManager.stopMicrophone() : ToCustomerAudioStreamManager.startMicrophone(selectedMic);
      CCP_V2V.UI.agentMuteTranscriptionButton.textContent = IsAgentTranscriptionMuted ? "Unmute" : "Mute";
    }
  }
}

async function loadTranslateLanguageCodes() {
  const translateLanguages = await listLanguages().catch((error) => {
    console.error(`${LOGGER_PREFIX} - loadTranslateLanguageCodes - Error listing languages:`, error);
    raiseError(`Error listing languages: ${error}`);
    return [];
  });

  translateLanguages.forEach((language) => {
    const option = document.createElement("option");
    option.value = language.LanguageCode;
    option.textContent = language.LanguageName;

    CCP_V2V.UI.customerTranslateFromLanguageSelect.appendChild(option);
    CCP_V2V.UI.customerTranslateToLanguageSelect.appendChild(option.cloneNode(true));

    CCP_V2V.UI.agentTranslateFromLanguageSelect.appendChild(option.cloneNode(true));
    CCP_V2V.UI.agentTranslateToLanguageSelect.appendChild(option.cloneNode(true));
  });
  //set en as default
  CCP_V2V.UI.customerTranslateFromLanguageSelect.value = "en";
  CCP_V2V.UI.customerTranslateToLanguageSelect.value = "es";

  CCP_V2V.UI.agentTranslateFromLanguageSelect.value = "en";
  CCP_V2V.UI.agentTranslateToLanguageSelect.value = "es";

  //pre-select saved translateFromLanguage
  const savedCustomerTranslateFromLanguage = getLocalStorageValueByKey("customerTranslateFromLanguage");
  if (savedCustomerTranslateFromLanguage) {
    CCP_V2V.UI.customerTranslateFromLanguageSelect.value = savedCustomerTranslateFromLanguage;
  }

  const savedAgentTranslateFromLanguage = getLocalStorageValueByKey("agentTranslateFromLanguage");
  if (savedAgentTranslateFromLanguage) {
    CCP_V2V.UI.agentTranslateFromLanguageSelect.value = savedAgentTranslateFromLanguage;
  }

  //pre-select saved translateToLanguage
  const savedCustomerTranslateToLanguage = getLocalStorageValueByKey("customerTranslateToLanguage");
  if (savedCustomerTranslateToLanguage) {
    CCP_V2V.UI.customerTranslateToLanguageSelect.value = savedCustomerTranslateToLanguage;
  }

  const savedAgentTranslateToLanguage = getLocalStorageValueByKey("agentTranslateToLanguage");
  if (savedAgentTranslateToLanguage) {
    CCP_V2V.UI.agentTranslateToLanguageSelect.value = savedAgentTranslateToLanguage;
  }
}

async function handleCustomerTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  //log transcript request timestamp
  // const timestamp = new Date().toISOString();
  // console.info(
  //   `${LOGGER_PREFIX} - handleCustomerTranscript - Transcript received at ${timestamp}`
  // );

  const fromLanguage = CCP_V2V.UI.customerTranslateFromLanguageSelect.value;
  const toLanguage = CCP_V2V.UI.customerTranslateToLanguageSelect.value;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - handleCustomerTranscript - Error translating text:`, error);
    raiseError(`Error translating text: ${error}`);
    return null;
  });

  if (!isStringUndefinedNullEmpty(translatedText)) {
    //log translated transcript request timestamp
    // const timestamp2 = new Date().toISOString();
    // console.info(
    //   `${LOGGER_PREFIX} - handleCustomerTranscript - Translated transcript received at ${timestamp2}`
    // );

    //log how long it took to translate
    // const timeDiff = new Date(timestamp2) - new Date(timestamp);
    // console.info(
    //   `${LOGGER_PREFIX} - handleCustomerTranscript - Translation took ${timeDiff}ms`
    // );

    synthesizeCustomerVoice(translatedText);
    //execute CCP_V2V.UI.customerTranslatedTextOutputDiv.textContent after 100ms
    setTimeout(() => {
      CCP_V2V.UI.customerTranslatedTextOutputDiv.textContent = translatedText;
    }, 100);
  }
}

async function handleAgentTranslateText() {
  const inputText = CCP_V2V.UI.agentTranslateTextInput.value;
  if (isStringUndefinedNullEmpty(inputText)) return;

  const fromLanguage = CCP_V2V.UI.agentTranslateFromLanguageSelect.value;
  const toLanguage = CCP_V2V.UI.agentTranslateToLanguageSelect.value;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText);

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeAgentVoice(translatedText);
    //execute CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent after 100ms
    setTimeout(() => {
      CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent = translatedText;
    }, 100);
  }
  CCP_V2V.UI.agentTranslateTextInput.value = "";
  CCP_V2V.UI.agentTranslateTextInput.focus();
}

async function handleAgentTranscript(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  const fromLanguage = CCP_V2V.UI.agentTranslateFromLanguageSelect.value;
  const toLanguage = CCP_V2V.UI.agentTranslateToLanguageSelect.value;
  const translatedText = await translateText(fromLanguage, toLanguage, inputText);

  if (!isStringUndefinedNullEmpty(translatedText)) {
    synthesizeAgentVoice(translatedText);
    //execute CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent after 100ms
    setTimeout(() => {
      CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent = translatedText;
    }, 100);
  }
}

function loadPollyLanguageCodes() {
  POLLY_LANGUAGE_CODES.forEach((languageCode) => {
    const option = document.createElement("option");
    option.value = languageCode;
    option.textContent = languageCode;
    CCP_V2V.UI.customerPollyLanguageCodeSelect.appendChild(option);
    CCP_V2V.UI.agentPollyLanguageCodeSelect.appendChild(option.cloneNode(true));
  });
  //set un - US as default
  CCP_V2V.UI.customerPollyLanguageCodeSelect.value = "en-US";
  CCP_V2V.UI.agentPollyLanguageCodeSelect.value = "en-US";

  //pre-select saved pollyLanguageCode
  const savedCUstomerPollyLanguageCode = getLocalStorageValueByKey("customerPollyLanguageCode");
  if (savedCUstomerPollyLanguageCode) {
    CCP_V2V.UI.customerPollyLanguageCodeSelect.value = savedCUstomerPollyLanguageCode;
  }

  const savedAgentPollyLanguageCode = getLocalStorageValueByKey("agentPollyLanguageCode");
  if (savedAgentPollyLanguageCode) {
    CCP_V2V.UI.agentPollyLanguageCodeSelect.value = savedAgentPollyLanguageCode;
  }
}

function loadPollyEngines() {
  POLLY_ENGINES.forEach((engine) => {
    const option = document.createElement("option");
    option.value = engine;
    option.textContent = engine;
    CCP_V2V.UI.customerPollyEngineSelect.appendChild(option);
    CCP_V2V.UI.agentPollyEngineSelect.appendChild(option.cloneNode(true));
  });

  //pre-select saved pollyEngine
  const savedCustomerPollyEngine = getLocalStorageValueByKey("customerPollyEngine");
  if (savedCustomerPollyEngine) {
    CCP_V2V.UI.customerPollyEngineSelect.value = savedCustomerPollyEngine;
  }

  const savedAgentPollyEngine = getLocalStorageValueByKey("agentPollyEngine");
  if (savedAgentPollyEngine) {
    CCP_V2V.UI.agentPollyEngineSelect.value = savedAgentPollyEngine;
  }
}

async function loadCustomerPollyVoiceIds() {
  const customerSelectedLanguageCode = CCP_V2V.UI.customerPollyLanguageCodeSelect.value;
  const customerSelectedPollyEngine = CCP_V2V.UI.customerPollyEngineSelect.value;

  const pollyVoices = await describeVoices(customerSelectedLanguageCode, customerSelectedPollyEngine).catch((error) => {
    console.error(`${LOGGER_PREFIX} - loadCustomerPollyVoiceIds - Error describing voices:`, error);
    raiseError(`Error describing voices: ${error}`);
    return [];
  });

  //clear pollyVoiceIdSelect
  CCP_V2V.UI.customerPollyVoiceIdSelect.innerHTML = "";

  pollyVoices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.Id;
    option.textContent = voice.Name;
    CCP_V2V.UI.customerPollyVoiceIdSelect.appendChild(option);
  });
  //pre-select saved pollyVoiceId
  const savedCustomerPollyVoiceId = getLocalStorageValueByKey("customerPollyVoiceId");
  if (savedCustomerPollyVoiceId) {
    CCP_V2V.UI.customerPollyVoiceIdSelect.value = savedCustomerPollyVoiceId;
  }
}

async function loadAgentPollyVoiceIds() {
  const agentSelectedLanguageCode = CCP_V2V.UI.agentPollyLanguageCodeSelect.value;
  const agentSelectedPollyEngine = CCP_V2V.UI.agentPollyEngineSelect.value;

  const pollyVoices = await describeVoices(agentSelectedLanguageCode, agentSelectedPollyEngine).catch((error) => {
    console.error(`${LOGGER_PREFIX} - loadAgentPollyVoiceIds - Error describing voices:`, error);
    raiseError(`Error describing voices: ${error}`);
    return [];
  });

  //clear pollyVoiceIdSelect
  CCP_V2V.UI.agentPollyVoiceIdSelect.innerHTML = "";

  pollyVoices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.Id;
    option.textContent = voice.Name;
    CCP_V2V.UI.agentPollyVoiceIdSelect.appendChild(option);
  });
  //pre-select saved pollyVoiceId
  const savedAgentPollyVoiceId = getLocalStorageValueByKey("agentPollyVoiceId");
  if (savedAgentPollyVoiceId) {
    CCP_V2V.UI.agentPollyVoiceIdSelect.value = savedAgentPollyVoiceId;
  }
}

async function synthesizeCustomerVoice(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  const selectedLanguageCode = CCP_V2V.UI.customerPollyLanguageCodeSelect.value;
  const selectedPollyEngine = CCP_V2V.UI.customerPollyEngineSelect.value;
  const selectedVoiceId = CCP_V2V.UI.customerPollyVoiceIdSelect.value;

  //log synth request timestamp
  // const timestamp = new Date().toISOString();
  // console.info(
  //   `${LOGGER_PREFIX} - synthesizeCustomerVoice - Synth request received at ${timestamp}`
  // );

  const synthetizedSpeech = await synthesizeSpeech(selectedLanguageCode, selectedPollyEngine, selectedVoiceId, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - synthesizeCustomerVoice - Error synthesizing speech:`, error);
    raiseError(`Error synthesizing speech: ${error}`);
    return null;
  });
  if (!synthetizedSpeech) return;

  //log synth response timestamp
  // const timestamp2 = new Date().toISOString();
  // console.info(
  //   `${LOGGER_PREFIX} - synthesizeCustomerVoice - Synth response received at ${timestamp2}`
  // );

  //log how much it took to synth
  // const timeDiff = new Date(timestamp2) - new Date(timestamp);
  // console.info(
  //   `${LOGGER_PREFIX} - synthesizeCustomerVoice - Synth took ${timeDiff} ms`
  // );

  //Play Customer Speech to Agent
  const audioContentArrayBufferPrimary = base64ToArrayBuffer(synthetizedSpeech);
  ToAgentAudioStreamManager.playAudioBuffer(audioContentArrayBufferPrimary);

  //Play Customer Speech to Customer
  if (CCP_V2V.UI.customerStreamTranslationCheckbox.checked === true) {
    const audioContentArrayBufferSecondary = base64ToArrayBuffer(synthetizedSpeech);
    ToCustomerAudioStreamManager.playAudioBuffer(audioContentArrayBufferSecondary, CUSTOMER_TRANSLATION_TO_CUSTOMER_VOLUME);
  }
}

async function synthesizeAgentVoice(inputText) {
  if (isStringUndefinedNullEmpty(inputText)) return;

  const selectedLanguageCode = CCP_V2V.UI.agentPollyLanguageCodeSelect.value;
  const selectedPollyEngine = CCP_V2V.UI.agentPollyEngineSelect.value;
  const selectedVoiceId = CCP_V2V.UI.agentPollyVoiceIdSelect.value;

  const synthetizedSpeech = await synthesizeSpeech(selectedLanguageCode, selectedPollyEngine, selectedVoiceId, inputText).catch((error) => {
    console.error(`${LOGGER_PREFIX} - synthesizeAgentVoice - Error synthesizing speech:`, error);
    raiseError(`Error synthesizing speech: ${error}`);
    return null;
  });
  if (!synthetizedSpeech) return;

  //Play Agent Speech to Customer
  const audioContentArrayBufferPrimary = base64ToArrayBuffer(synthetizedSpeech);
  ToCustomerAudioStreamManager.playAudioBuffer(audioContentArrayBufferPrimary);

  //Play Agent Speech to Agent
  if (CCP_V2V.UI.agentStreamTranslationCheckbox.checked === true) {
    const audioContentArrayBufferSecondary = base64ToArrayBuffer(synthetizedSpeech);
    ToAgentAudioStreamManager.playAudioBuffer(audioContentArrayBufferSecondary, AGENT_TRANSLATION_TO_AGENT_VOLUME);
  }
}

async function handleAgentSynthesizeSpeech() {
  const inputText = CCP_V2V.UI.agentPollyTextInput.value;
  if (isStringUndefinedNullEmpty(inputText)) return;

  synthesizeAgentVoice(inputText);
  CCP_V2V.UI.agentPollyTextInput.value = "";
  CCP_V2V.UI.agentPollyTextInput.focus();
}

function cleanUpUI() {
  CCP_V2V.UI.customerTranslatedTextOutputDiv.textContent = "";
  CCP_V2V.UI.customerTranscriptionTextOutputDiv.textContent = "";

  CCP_V2V.UI.agentTranscriptionTextOutputDiv.textContent = "";
  CCP_V2V.UI.agentTranslateTextInput.value = "";
  CCP_V2V.UI.agentTranslatedTextOutputDiv.textContent = "";
  CCP_V2V.UI.agentPollyTextInput.value = "";
}

function raiseError(errorMessage) {
  alert(`${errorMessage}`);
}
