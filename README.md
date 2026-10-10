# Cocpit Admin Panel Backend

Dedicated microservice backend for the Cocpit Admin Panel.

## Features
- **Admin Authentication**: JWT-based access and refresh tokens with isolated secrets.
- **Role-Based Access Control (RBAC)**: Support for Super Admin, Admin, Moderator, and Support roles.
- **User Management**: Query and filter end-users, activate/deactivate accounts.
- **Audit Logging**: Track administrative actions and mutations.
- **System Metrics & Monitoring**: Server resource utilization and health indicators.
- **Inter-service API Security**: Shared secret communication with core backend services.

## Tech Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: PostgreSQL (`pg`)
- **Cache**: Redis (`ioredis`)
- **Email Service**: Resend (`resend`)
- **Security**: Helmet, CORS, bcryptjs, jsonwebtoken, express-rate-limit

## Getting Started

### 1. Installation
```bash
npm install
```

### 2. Environment Configuration
Copy the `.env.example` file to `.env` and fill in your environment variables:
```bash
cp .env.example .env
```

### 3. Running the Server
- Development:
  ```bash
  npm run dev
  ```
- Production:
  ```bash
  npm start
  ```

## API Health Check
```
GET /health
```
