
# Sambhav Official - Event Ticketing Backend

A robust, production-ready Node.js backend designed to power event registration, secure payment processing, and automated ticket generation for the **Sambhav Club**. This system ensures high reliability for high-traffic student events by utilizing a webhook-first payment architecture.

## 🚀 Key Features

* **Secure Payment Integration:** Full integration with **Razorpay**, featuring a dual-layer verification system (Frontend Signature Verification + Backend Webhooks) to prevent payment tampering.
* **Automated Ticket Generation:** Dynamic PDF generation using `pdf-lib` and unique QR code creation for each attendee.
* **Reliable Email Delivery:** Automated ticket delivery via **SendGrid** with PDF attachments.
* **Admin Dashboard API:** Protected routes for event management and real-time attendee tracking.
* **Pre-registration Logic:** State-management for "pending payments" to ensure user data is captured even if a transaction is interrupted.
* **Data Export:** Built-in utility to export MongoDB ticket collections directly to CSV for administrative use.

## 🛠️ Tech Stack

* **Runtime:** Node.js
* **Framework:** Express.js
* **Database:** MongoDB (via official MongoDB Driver)
* **Payments:** Razorpay API & Webhooks
* **Communication:** SendGrid Mail API
* **Security:** Express-Session, Crypto (HMAC SHA256), and CORS management
* **PDF/Media:** pdf-lib, qrcode

## 🏗️ Architecture & Security

### 1. Payment Integrity

The project implements a **fail-safe payment flow**:

1. **Order Creation:** Frontend initiates an order via `/api/create-order`.
2. **Frontend Verification:** The `/api/verify-payment` route validates the Razorpay signature immediately for user feedback.
3. **Webhook Redundancy:** A dedicated `/api/razorpay-webhook` endpoint listens for `payment.captured` events directly from Razorpay's servers. This ensures tickets are generated even if the user closes their browser before the frontend redirect occurs.

### 2. Session-Based Admin Auth

Uses `express-session` with secure cookie configurations and a custom `requireAdminLogin` middleware to protect sensitive registration data.

## 📋 API Endpoints

### Public Routes

* `POST /api/create-order` - Initializes Razorpay transaction.
* `POST /api/pre-register` - Saves attendee form data before payment.
* `POST /api/verify-payment` - Validates payment signatures and issues tickets.
* `GET /api/events` - Fetches active event lists.

### Admin Routes (Protected)

* `POST /api/login` - Administrative authentication.
* `GET /api/registrations` - Retrieves all ticketed attendees with sorting.
* `POST /api/logout` - Terminates session and clears cookies.

## ⚙️ Environment Variables

To run this project, you will need to add the following variables to your `.env` file:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
RAZORPAY_KEY_ID=your_key
RAZORPAY_KEY_SECRET=your_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
SENDGRID_API_KEY=your_sendgrid_key
VERIFIED_SENDER_EMAIL=your_email
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password
SESSION_SECRET=your_session_secret

```

## 🚀 Installation & Setup

1. **Clone the repository:**
```bash
git clone <repository-url>
cd SambhavofficialBackend

```


2. **Install dependencies:**
```bash
npm install

```


3. **Run in Development mode:**
```bash
npm run dev

```


4. **Export Data (Optional):**
To export current registrations to CSV:
```bash
node export.js

```



---

*Developed by Shivanand H. Potle*
