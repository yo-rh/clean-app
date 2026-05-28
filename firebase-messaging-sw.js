importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDlA5KRdh52Is8Gb78JulcMjcPROl5tQ-0",
  authDomain: "clean-app-5de06.firebaseapp.com",
  projectId: "clean-app-5de06",
  storageBucket: "clean-app-5de06.firebasestorage.app",
  messagingSenderId: "82379739846",
  appId: "1:82379739846:web:8ad0fce19cc89958d97dc7",
  measurementId: "G-VLH9KQB80W"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || "Clean’ App";
  const body = payload?.notification?.body || payload?.data?.body || "Nouveau message";
  const url = payload?.data?.url || payload?.fcmOptions?.link || "/";

  self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-180.png",
    badge: "/icons/icon-180.png",
    data: { url }
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      const sameClient = windowClients.find((client) => client.url.includes(self.location.origin));
      if (sameClient) return sameClient.focus();
      return clients.openWindow(targetUrl);
    })
  );
});
