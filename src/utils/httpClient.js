const axios = require('axios');
const axiosRetry = require('axios-retry').default;

const mainApiBase = process.env.MAIN_API_URL || 'http://localhost:5000';

// Configure the internal API client for inter-service communication
const httpClient = axios.create({
  baseURL: `${mainApiBase}/api/internal`,
  timeout: 5000,
  headers: {
    'x-internal-api-secret': process.env.INTERNAL_API_SECRET
  }
});

// Configure Exponential Backoff Retries
axiosRetry(httpClient, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status >= 500;
  }
});

module.exports = httpClient;
