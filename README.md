# Share File 📂

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)

**Fast, Secure, Peer-to-Peer File Sharing directly in your browser.**

Share File is a modern web application that allows you to transfer text and files directly between devices using WebRTC. Data is transferred peer-to-peer and never stored on a server. Supabase Realtime is used solely for signaling (handshaking) to establish the connection.

## ✨ Features

- **P2P File Transfer**: Send files directly between devices without cloud storage limits.
- **Text Sharing**: Instantly share text/clipboard data to another device.
- **Secure**: End-to-end direct connection; files never touch our servers.
- **No Sign-up**: Simply use a 6-digit code to pair.
- **Cross-Platform**: Works on any modern browser (Desktop and Mobile).

## 🔒 Privacy & Security

- **Direct Connection**: File data flows directly from Sender to Receiver via WebRTC DataChannels.
- **Ephemeral Signaling**: Supabase Realtime is used only to exchange connection offers/answers. No file data passes through Supabase.
- **STUN Servers**: By default, the app uses public STUN servers to navigate NATs. These servers only see IP addresses, not file data.

## 🛠️ Tech Stack

- **Frontend**: [Vite](https://vitejs.dev/) with Vanilla JavaScript
- **Signaling**: [Supabase Realtime](https://supabase.com/docs/guides/realtime)
- **Data Transfer**: [WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- **Styling**: Vanilla CSS

## 🚀 Getting Started

Follow these instructions to get a copy of the project up and running on your local machine.

### Prerequisites

- [Node.js](https://nodejs.org/) (Internet connection required for Supabase and STUN servers)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/share-file.git
   cd share-file
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Configuration

You need a Supabase project for signaling.

1. Create a `.env` file based on the example:
   ```bash
   cp .env.example .env
   ```

2. Add your Supabase credentials to `.env`:
   ```env
   VITE_SUPABASE_URL=your_supabase_project_url
   VITE_SUPABASE_KEY=your_supabase_anon_public_key
   ```
   > **Note**: The `VITE_SUPABASE_KEY` should be your **anon public key**. Since we use Realtime Broadcast, no database tables or Row Level Security (RLS) policies are strictly required.

### Running Locally

Start the development server:

```bash
npm run dev
```

Open your browser and navigate to `http://localhost:5173` (or the URL shown in terminal).

## 📖 Usage

1. **Open the app** on two devices (e.g., Laptop and Phone).
2. **Sender**: Click "Send" to generate a **6-digit code**.
3. **Receiver**: Click "Receive", enter the code, and connect.
4. **Transfer**: Once paired, you can type text or drag-and-drop files to send them instantly.

## ⚠️ Troubleshooting & Limitations

- **Network Isolation**: Some public Wi-Fi networks (hotels, cafes) enable client isolation, which may block P2P connections.
- **Secure Context**: WebRTC and Clipboard APIs require **HTTPS** or `localhost`.
- **Browser Support**:
  - **Chromium (Chrome, Edge, Brave)**: Best experience. Supports receiving and saving files directly to disk.
  - **Safari / Firefox**: connection works, but efficient file saving/downloading may be limited by browser implementation of the File System Access API.

## 📂 Project Structure

```
src/
├── services/       # Supabase client and signaling logic
├── webrtc/         # WebRTC implementation (PeerConnection, DataChannel)
├── utils/          # Helper functions (clipboard, formatting)
├── main.js         # Application entry point & UI logic
├── style.css       # Global styles
└── faqContent.js   # Content for the FAQ section
```

## 📦 Deployment

Build the application for production:

```bash
npm run build
```

The output will be in the `dist/` folder, ready to be deployed to any static hosting service (Vercel, Netlify, GitHub Pages, etc.).

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License.
