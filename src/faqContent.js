export const FAQ_INTRO = [
  "Ever tried to send a screenshot from your phone to your laptop, only to be blocked by different operating systems?",
  "Have you felt the absurdity of emailing yourself a password or uploading a private file to a social app just to move it three feet?",
  "Share File exists to end these daily struggles. It cuts through ecosystem barriers and network isolation, providing a secure, instant direct link for your text and files—no USB drive, login, or cloud footprint required.",
];

export const FAQ_ITEMS = [
  {
    q: "What is Share File?",
    a: [
      "Share File is a lightweight web app that lets two people exchange a message or a file by opening the site on both devices and entering a 6-digit code. Once connected, Share File creates a direct data channel between the devices and streams the content end-to-end over that connection.",
      "It’s ideal for quick, no-signup transfers when you want to move something from one device to another without emailing it to yourself.",
    ],
  },
  {
    q: "Does Share File upload or store my files?",
    a: [
      "No. Share File is built to avoid uploading your file contents to an app server. The site uses a cloud signaling service only to help the two browsers find each other and agree on a connection, then the file data goes peer-to-peer.",
      "If you refresh the page or close the tab, Share File does not keep a copy of what you sent, and there’s no account history to browse later.",
    ],
  },
  {
    q: "Is Share File secure and private?",
    a: [
      "Share File relies on WebRTC, which encrypts data in transit between browsers. Your pairing code is only used to coordinate the connection; it is not a password to a stored file.",
      "For best privacy, share the code through a trusted channel (for example, read it out loud, or message it to the person you intend). Like any real-time tool, Share File depends on your network environment, so using it on HTTPS and avoiding untrusted Wi‑Fi is recommended.",
    ],
  },
  {
    q: "What is the 6-digit code in Share File?",
    a: [
      "The 6-digit code is a short “meeting point” that helps two sessions join the same temporary room for signaling. In Share File, one side generates the code and the other side enters it to join.",
      "When both sides are present, the app exchanges connection details and then switches to a direct peer-to-peer link for the actual transfer. If you entered the code and nothing happens, double-check all digits and make sure both devices are online.",
    ],
  },
  {
    q: "Why might Share File fail even on the same Wi‑Fi?",
    a: [
      "Some routers and public hotspots enable “client isolation” (devices can reach the internet but cannot talk to each other). Corporate networks and VPNs can also block or reshape peer-to-peer traffic.",
      "When that happens, Share File may show connecting but never complete. If you control the network, disable guest mode or isolation; otherwise try a different connection (a mobile hotspot often works). Share File is fastest on a clean direct path, but it can’t override network policies.",
    ],
  },
  {
    q: "Which browsers work best with Share File?",
    a: [
      "Most modern browsers support WebRTC, so Share File should connect on Chrome, Edge, Firefox, and Safari in many cases. For the best receiving experience, desktop Chrome/Edge are recommended because they can prompt you to pick a save location and stream the file to disk while it arrives.",
      "If your browser can’t do that, Share File will still transfer the data, but saving may be handled differently depending on the platform.",
    ],
  },
  {
    q: "How do I share large files with Share File?",
    a: [
      "For large transfers, keep both devices awake and avoid switching networks mid-transfer. Share File sends files in chunks and adapts to backpressure so it won’t overwhelm the browser’s send buffer.",
      "Still, very large files can take time, especially on high-latency paths. If you see the transfer stall, pause other heavy network usage and consider moving closer to the router or switching to a more stable connection.",
    ],
  },
  {
    q: "What should I do if Share File is stuck on “Connecting”?",
    a: [
      "First, confirm both devices are using the same 6-digit code and that your browser has permission to use the network. Then try reloading both tabs and generating a new code.",
      "If you’re on a restrictive Wi‑Fi, switch networks (or disable VPN/proxy) and try again. Finally, check that the site is served over HTTPS, since some browser features required by Share File are limited on insecure origins.",
    ],
  },
];

