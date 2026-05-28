const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { GoogleGenAI } = require("@google/genai");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const WEBAPP_URL = "https://clean-app-5de06.web.app/";

function getMessagePayload({ title, body, url }) {
  return {
    notification: {
      title: String(title || "Clean’ App"),
      body: String(body || "Vous avez une nouvelle notification."),
    },
    webpush: {
      fcmOptions: {
        link: String(url || WEBAPP_URL),
      },
      notification: {
        icon: "/icons/icon-180.png",
      },
    },
  };
}

async function isAdminUser(uid) {
  const userSnap = await admin.firestore().collection("users").doc(uid).get();
  if (!userSnap.exists) return false;
  const data = userSnap.data() || {};
  const role = String(data.role || "").trim().toLowerCase();
  return data.isAdmin === true || role === "admin" || role === "administrateur";
}

async function sendNotificationToUid({ uid, title, body, url }) {
  const tokensSnap = await admin
    .firestore()
    .collection("users")
    .doc(uid)
    .collection("notificationTokens")
    .get();

  const activeTokens = tokensSnap.docs
    .filter((docSnap) => docSnap.data()?.enabled !== false)
    .map((docSnap) => docSnap.id)
    .filter(Boolean);

  if (!activeTokens.length) {
    return { success: true, sent: 0, failed: 0 };
  }

  const payload = getMessagePayload({ title, body, url });
  const invalidTokens = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    activeTokens.map(async (token) => {
      try {
        await admin.messaging().send({ token, ...payload });
        sent += 1;
      } catch (error) {
        failed += 1;
        const code = String(error?.errorInfo?.code || "");
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token")
        ) {
          invalidTokens.push(token);
        }
      }
    })
  );

  if (invalidTokens.length) {
    const batch = admin.firestore().batch();
    invalidTokens.forEach((token) => {
      const ref = admin
        .firestore()
        .collection("users")
        .doc(uid)
        .collection("notificationTokens")
        .doc(token);
      batch.set(
        ref,
        {
          enabled: false,
          invalidAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
    await batch.commit();
  }

  return { success: true, sent, failed };
}

exports.generateContactMessage = onCall(
  {
    region: "europe-west1",
    secrets: [geminiApiKey],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "Vous devez être connecté pour utiliser cette fonction."
      );
    }

    const messageBrut = String(request.data?.messageBrut || "").trim();
    const langueIntervenante = String(request.data?.langueIntervenante || "").trim();
    const prenomIntervenante = String(request.data?.prenomIntervenante || "").trim();

    if (!messageBrut) {
      throw new HttpsError(
        "invalid-argument",
        "Le message ne peut pas être vide."
      );
    }

    if (messageBrut.length > 600) {
      throw new HttpsError(
        "invalid-argument",
        "Le message ne peut pas dépasser 600 caractères."
      );
    }

    if (!langueIntervenante) {
      throw new HttpsError(
        "invalid-argument",
        "La langue de l’intervenante est obligatoire."
      );
    }

    try {
      const ai = new GoogleGenAI({
        apiKey: geminiApiKey.value(),
      });

      const prompt = `
Tu es l’assistant de rédaction de Clean’ App.

Contexte :
Un particulier souhaite écrire un message WhatsApp à son intervenante de ménage.

Prénom de l’intervenante :
${prenomIntervenante || "Non renseigné"}

Langue cible :
${langueIntervenante}

Message brut du particulier :
${messageBrut}

Ta mission :
- reformule le message de manière claire, polie, naturelle et professionnelle ;
- traduis le message dans la langue cible ;
- garde un ton simple, humain et respectueux ;
- ne rajoute aucune information non donnée par le particulier ;
- ne mentionne pas que le message a été reformulé ou traduit ;
- ne donne aucune explication ;
- retourne uniquement le message final prêt à envoyer sur WhatsApp.
`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      });

      const messageFinal = response.text?.trim();

      if (!messageFinal) {
        throw new Error("Réponse Gemini vide.");
      }

      return {
        messageFinal,
      };
    } catch (error) {
      console.error("Erreur Gemini generateContactMessage:", error);

      throw new HttpsError(
        "internal",
        "Impossible de générer le message pour le moment."
      );
    }
  }
);

exports.sendNotificationToUser = onCall({ region: "europe-west1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Connexion requise.");
  }

  const uid = String(request.data?.uid || "").trim();
  if (!uid) {
    throw new HttpsError("invalid-argument", "uid manquant.");
  }

  const callerUid = request.auth.uid;
  const callerIsAdmin = await isAdminUser(callerUid);
  if (uid !== callerUid && !callerIsAdmin) {
    throw new HttpsError(
      "permission-denied",
      "Vous pouvez envoyer une notification test uniquement à votre compte."
    );
  }

  const title = String(request.data?.title || "").trim() || "Clean’ App";
  const body = String(request.data?.body || "").trim() || "Vous avez une nouvelle notification.";
  const url = String(request.data?.url || "").trim() || WEBAPP_URL;

  return sendNotificationToUid({ uid, title, body, url });
});

exports.sendTestNotificationToMe = onCall({ region: "europe-west1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Connexion requise.");
  }

  return sendNotificationToUid({
    uid: request.auth.uid,
    title: "Clean’ App",
    body: "Les notifications sont bien activées.",
    url: WEBAPP_URL,
  });
});
