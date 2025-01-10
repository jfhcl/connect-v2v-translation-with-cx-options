// Copyright 2025 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { COGNITO_CONFIG } from "../config";
import { LOGGER_PREFIX } from "../constants";

export function setRedirectURI(redirectURI) {
  const currentUrl = redirectURI ?? window.location.href;
  const url = new URL(currentUrl);
  const redirectUri = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  //set redirect uri in local storage
  localStorage.setItem("redirectUri", redirectUri);
}

function getRedirectURI() {
  return localStorage.getItem("redirectUri");
}

// Generate the Cognito hosted UI URL
export function getLoginUrl() {
  const params = new URLSearchParams({
    client_id: COGNITO_CONFIG.clientId,
    response_type: "code",
    scope: "email openid profile",
    redirect_uri: getRedirectURI(),
  });

  return `${COGNITO_CONFIG.cognitoDomain}/login?${params.toString()}`;
}

// Handle the redirect from Cognito
export async function handleRedirect() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");

  if (code) {
    try {
      // Exchange the code for tokens
      const tokens = await getTokens(code);
      // Store tokens
      setTokens(tokens);
      // Remove code from URL
      window.history.replaceState({}, document.title, window.location.pathname);
      return true;
    } catch (error) {
      console.error(`${LOGGER_PREFIX} - handleRedirect - Error exchanging code for tokens:`, error);
      return false;
    }
  }
  return false;
}

// Exchange authorization code for tokens
async function getTokens(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: COGNITO_CONFIG.clientId,
    code: code,
    redirect_uri: getRedirectURI(),
  });

  const response = await fetch(`${COGNITO_CONFIG.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error("Failed to exchange code for tokens");
  }
  console.info(`${LOGGER_PREFIX} - getTokens - Tokens obtained`);
  return response.json();
}

// Store tokens in localStorage
function setTokens(tokens) {
  localStorage.setItem("accessToken", tokens.access_token);
  localStorage.setItem("idToken", tokens.id_token);
  if (tokens.refresh_token) {
    localStorage.setItem("refreshToken", tokens.refresh_token);
  }
}

function setAwsCredentials(awsCredentials) {
  localStorage.setItem("awsCredentials", JSON.stringify(awsCredentials));
}

function getAwsCredentials() {
  const awsCredentials = localStorage.getItem("awsCredentials");
  return JSON.parse(awsCredentials);
}

export function isTokenExpired() {
  const token = localStorage.getItem("accessToken");
  if (!token) return true;

  try {
    // Get payload from JWT token (second part between dots)
    const payload = JSON.parse(atob(token.split(".")[1]));

    // exp is in seconds, convert current time to seconds
    const currentTime = Math.floor(Date.now() / 1000);

    // Check if token has expired
    return payload.exp < currentTime;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - getAwsCredentials - Error checking token expiration:`, error);
    return true;
  }
}

export async function refreshTokens() {
  const refreshToken = localStorage.getItem("refreshToken");
  if (!refreshToken) {
    throw new Error("No refresh token available");
  }

  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: COGNITO_CONFIG.clientId,
      refresh_token: refreshToken,
    });

    const response = await fetch(`${COGNITO_CONFIG.cognitoDomain}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error("Failed to refresh tokens");
    }

    const tokens = await response.json();
    setTokens(tokens);
    console.info(`${LOGGER_PREFIX} - refreshTokens - Tokens refreshed`);
    return tokens;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - refreshTokens - Error refreshing tokens:`, error);
    // Clear stored tokens and redirect to login
    logout();
    throw error;
  }
}

// Update isAuthenticated to check expiration
export function isAuthenticated() {
  return localStorage.getItem("accessToken") && !isTokenExpired();
}

// Get valid access token (refreshing if needed)
export async function getValidTokens() {
  if (isTokenExpired()) {
    try {
      await refreshTokens();
    } catch (error) {
      console.error(`${LOGGER_PREFIX} - getValidTokens - Error refreshing tokens:`, error);
      return null;
    }
  }
  return {
    accessToken: localStorage.getItem("accessToken"),
    idToken: localStorage.getItem("idToken"),
    refreshToken: localStorage.getItem("refreshToken"),
  };
}

// Helper to decode token payload
export function decodeToken(token) {
  try {
    return JSON.parse(atob(token.split(".")[1]));
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - decodeToken - Error decoding token:`, error);
    return null;
  }
}

// Get user info from token
export function getUserInfo() {
  const token = localStorage.getItem("idToken");
  if (!token) return null;

  const payload = decodeToken(token);
  return {
    email: payload.email,
    username: payload.preferred_username,
    sub: payload.sub,
  };
}

export function startTokenRefreshTimer() {
  const token = localStorage.getItem("accessToken");
  if (!token) return;

  const payload = decodeToken(token);
  if (!payload) return;

  // Calculate time until token expires
  const expiresIn = payload.exp * 1000 - Date.now();

  // Refresh 5 minutes before expiration
  const refreshTime = expiresIn - 5 * 60 * 1000;

  if (refreshTime > 0) {
    console.info(`${LOGGER_PREFIX} - startTokenRefreshTimer - Token refresh timer set for ${refreshTime} ms`);
    setTimeout(async () => {
      try {
        await refreshTokens();
        // Start new timer after refresh
        startTokenRefreshTimer();
      } catch (error) {
        console.error(`${LOGGER_PREFIX} - startTokenRefreshTimer - Error in refresh timer:`, error);
      }
    }, refreshTime);
  }
}

export function logout() {
  const params = new URLSearchParams({
    client_id: COGNITO_CONFIG.clientId,
    logout_uri: getRedirectURI(),
  });

  // Clear local storage
  localStorage.removeItem("accessToken");
  localStorage.removeItem("idToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("awsCredentials");

  // Redirect to Cognito logout
  window.location.href = `${COGNITO_CONFIG.cognitoDomain}/logout?${params.toString()}`;
}

async function getCognitoIdentityCredentials(idToken) {
  // First, get the Cognito Identity ID
  const identityParams = {
    IdentityPoolId: COGNITO_CONFIG.identityPoolId,
    Logins: {
      [`cognito-idp.${COGNITO_CONFIG.region}.amazonaws.com/${COGNITO_CONFIG.userPoolId}`]: idToken,
    },
  };

  try {
    // Get Identity ID
    const cognitoIdentity = new AWS.CognitoIdentity({
      region: COGNITO_CONFIG.region,
    });
    const { IdentityId } = await cognitoIdentity.getId(identityParams).promise();

    // Get credentials
    const cognitoCredentialsForIdentity = await cognitoIdentity
      .getCredentialsForIdentity({
        IdentityId,
        Logins: {
          [`cognito-idp.${COGNITO_CONFIG.region}.amazonaws.com/${COGNITO_CONFIG.userPoolId}`]: idToken,
        },
      })
      .promise();

    const credentials = {
      accessKeyId: cognitoCredentialsForIdentity.Credentials.AccessKeyId,
      secretAccessKey: cognitoCredentialsForIdentity.Credentials.SecretKey,
      sessionToken: cognitoCredentialsForIdentity.Credentials.SessionToken,
      expiration: cognitoCredentialsForIdentity.Credentials.Expiration,
    };

    setAwsCredentials(credentials);
    return credentials;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - getCognitoIdentityCredentials - Error getting Cognito Identity credentials:`, error);
    throw error;
  }
}

// Get AWS credentials using Cognito Identity Pool
export async function getValidAwsCredentials() {
  try {
    if (hasValidAwsCredentials()) {
      return getAwsCredentials();
    }

    const tokens = await getValidTokens();

    if (tokens?.accessToken == null || tokens?.idToken == null || tokens?.refreshToken == null) {
      throw new Error("No tokens available");
    }

    // Configure the credentials provider
    const credentials = await getCognitoIdentityCredentials(tokens.idToken);
    return credentials;
  } catch (error) {
    console.error(`${LOGGER_PREFIX} - getValidAwsCredentials - Error getting AWS credentials:`, error);
    throw error;
  }
}

export function hasValidAwsCredentials() {
  const awsCredentials = getAwsCredentials();
  if (
    awsCredentials?.accessKeyId == null ||
    awsCredentials?.secretAccessKey == null ||
    awsCredentials?.sessionToken == null ||
    awsCredentials?.expiration == null
  ) {
    return false;
  }

  // Add a 15-minute buffer before expiration
  const bufferTime = 15 * 60 * 1000; // 5 minutes in milliseconds
  const currentTime = new Date();
  const expirationTime = new Date(awsCredentials.expiration);
  // console.info(
  //   `${LOGGER_PREFIX} - hasValidAwsCredentials - AWS Credentials expiration: ${expirationTime.toISOString()}`
  // );

  return currentTime.getTime() + bufferTime < expirationTime.getTime();
}
