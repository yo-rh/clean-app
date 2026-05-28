const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
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



async function sendPushToUser(uid, payload) {
  const userUid = String(uid || "").trim();
  if (!userUid) return { success: false, sent: 0, failed: 0 };

  const tokensSnap = await admin
    .firestore()
    .collection("users")
    .doc(userUid)
    .collection("notificationTokens")
    .get();

  const activeTokenDocs = tokensSnap.docs.filter((docSnap) => docSnap.data()?.enabled !== false);
  if (!activeTokenDocs.length) {
    logger.info("Aucun token actif pour cet utilisateur", { uid: userUid });
    return { success: true, sent: 0, failed: 0 };
  }

  const invalidTokens = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(activeTokenDocs.map(async (tokenDoc) => {
    const token = tokenDoc.id;
    try {
      await admin.messaging().send({ token, ...payload });
      sent += 1;
    } catch (error) {
      failed += 1;
      const code = String(error?.errorInfo?.code || "");
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
        invalidTokens.push(token);
      }
    }
  }));

  if (invalidTokens.length) {
    const batch = admin.firestore().batch();
    invalidTokens.forEach((token) => {
      const ref = admin.firestore().collection("users").doc(userUid).collection("notificationTokens").doc(token);
      batch.set(ref, {
        enabled: false,
        invalidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      logger.info("Token invalide désactivé", { uid: userUid, token });
    });
    await batch.commit();
  }

  return { success: true, sent, failed };
}

function isCancelledSession(session) {
  const status = String(session?.status || "").toLowerCase();
  return ["annulee", "annulée", "annule", "annulé", "cancelled", "canceled"].includes(status) || session?.cancelled === true || session?.isCancelled === true;
}

function isCompletedSession(session) {
  const status = String(session?.status || "").toLowerCase();
  return status === "completed" || status === "terminee_intervenante" || status === "terminee" || status === "terminée" || session?.completed === true;
}

function sessionBalanceDue(session) {
  const explicitDue = Number(session?.balanceDue ?? session?.remainingAmount ?? session?.dueAmount);
  if (Number.isFinite(explicitDue) && explicitDue >= 0) return explicitDue;
  const expected = Number(session?.amount ?? session?.expectedAmount ?? session?.price ?? 0);
  const paid = Number(session?.paidAmount ?? session?.amountPaid ?? session?.payment?.amount ?? 0);
  return Math.max(0, expected - paid);
}

exports.notifySessionValidated = onCall(
  {
    region: "europe-west1",
    cors: [
      "https://yo-rh.github.io",
      "http://localhost:5000",
      "http://127.0.0.1:5000",
      "http://localhost:5173",
    ],
  },
  async (request) => {
    console.log("notifySessionValidated appelée", {
      authUid: request.auth && request.auth.uid,
      data: request.data,
    });

    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Connexion requise pour notifier le client.");
    }

    const { sessionId, foyerId } = request.data || {};
    const normalizedSessionId = String(sessionId || "").trim();
    const normalizedFoyerId = String(foyerId || request.data?.homeId || "").trim();

    console.log("Session ID reçu", normalizedSessionId);
    console.log("Foyer ID reçu", normalizedFoyerId);

    if (!normalizedSessionId || !normalizedFoyerId) {
      throw new HttpsError("invalid-argument", "sessionId et foyerId sont requis.");
    }

    const callerUid = request.auth.uid;
    const sessionRef = admin
      .firestore()
      .collection("users")
      .doc(normalizedFoyerId)
      .collection("entries")
      .doc(normalizedSessionId);
    const sessionSnap = await sessionRef.get();

    if (!sessionSnap.exists) {
      return { success: false, reason: "SESSION_NOT_FOUND" };
    }

    const sessionData = sessionSnap.data() || {};

    if (sessionData.clientNotificationSent === true) {
      return { success: false, reason: "ALREADY_SENT" };
    }

    if (String(sessionData.type || "") !== "session") {
      throw new HttpsError("failed-precondition", "Entrée non compatible avec une session.");
    }

    if (!isCompletedSession(sessionData)) {
      throw new HttpsError("failed-precondition", "Session non validée.");
    }

    const workerLink = await admin
      .firestore()
      .collection("users")
      .doc(callerUid)
      .collection("workerHomes")
      .doc(normalizedFoyerId)
      .get();
    const workerAccess = workerLink.exists ? (workerLink.data() || {}) : {};
    if (workerAccess.active === false || String(workerAccess.role || "") !== "intervenante") {
      throw new HttpsError("permission-denied", "Utilisateur non autorisé pour ce foyer.");
    }

    const foyerSnap = await admin.firestore().collection("users").doc(normalizedFoyerId).get();
    const foyerData = foyerSnap.exists ? (foyerSnap.data() || {}) : {};
    const clientUid = String(
      sessionData.clientUid ||
      sessionData.clientId ||
      sessionData.userUid ||
      foyerData.uid ||
      foyerData.firebaseUid ||
      foyerData.authUid ||
      normalizedFoyerId ||
      ""
    ).trim();

    if (!clientUid) {
      return { success: false, reason: "CLIENT_UID_NOT_FOUND" };
    }

    console.log("Client UID trouvé", clientUid);

    const tokensSnap = await admin
      .firestore()
      .collection("users")
      .doc(clientUid)
      .collection("notificationTokens")
      .get();

    const activeTokens = tokensSnap.docs
      .filter((docSnap) => docSnap.data()?.enabled !== false)
      .map((docSnap) => docSnap.id)
      .filter(Boolean);

    console.log("Nombre de tokens actifs", activeTokens.length);

    if (!activeTokens.length) {
      return { success: false, reason: "NO_ACTIVE_TOKENS", clientUid };
    }

    const workerSnap = await admin.firestore().collection("users").doc(callerUid).get();
    const workerProfileSnap = await admin.firestore().collection("cleanerProfiles").doc(callerUid).get();
    const workerData = workerSnap.exists ? (workerSnap.data() || {}) : {};
    const workerProfile = workerProfileSnap.exists ? (workerProfileSnap.data() || {}) : {};
    const workerFirstName = String(
      workerProfile.firstName ||
      workerData.settings?.workerFirstName ||
      workerData.firstName ||
      workerData.prenom ||
      ""
    ).trim();
    const body = workerFirstName
      ? `${workerFirstName} vient de valider la session.`
      : "L’intervenante vient de valider la session.";

    const payload = {
      notification: {
        title: "Clean’ App",
        body,
      },
      webpush: {
        fcmOptions: {
          link: "https://yo-rh.github.io/clean-app/",
        },
        notification: {
          icon: "/clean-app/icons/icon-180.png",
        },
      },
    };

    const invalidTokens = [];
    let sent = 0;
    let failed = 0;

    await Promise.all(activeTokens.map(async (token) => {
      try {
        await admin.messaging().send({ token, ...payload });
        sent += 1;
      } catch (error) {
        failed += 1;
        console.error("Erreur envoi notification session validée", {
          token,
          message: error?.message || String(error),
          code: error?.errorInfo?.code,
        });
        const code = String(error?.errorInfo?.code || "");
        if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
          invalidTokens.push(token);
        }
      }
    }));

    if (invalidTokens.length) {
      const batch = admin.firestore().batch();
      invalidTokens.forEach((token) => {
        const ref = admin
          .firestore()
          .collection("users")
          .doc(clientUid)
          .collection("notificationTokens")
          .doc(token);
        batch.set(ref, {
          enabled: false,
          invalidAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      await batch.commit();
    }

    await sessionRef.set({
      clientNotificationSent: true,
      clientNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log("Notification session validée envoyée");
    logger.info("Notification session validée traitée", {
      sessionId: normalizedSessionId,
      foyerId: normalizedFoyerId,
      clientUid,
      sent,
      failed,
    });

    return { success: true, sent, failed };
  }
);

exports.scheduledSessionReminder = onSchedule({
  schedule: "0 18 * * *",
  timeZone: "Europe/Paris",
  region: "europe-west1",
}, async () => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, 0, 0, 0));
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);

  const sessionsSnap = await admin.firestore().collectionGroup("entries")
    .where("type", "==", "session")
    .where("date", ">=", startIso)
    .where("date", "<", endIso)
    .get();

  for (const docSnap of sessionsSnap.docs) {
    const session = docSnap.data() || {};
    const sessionRef = docSnap.ref;
    const sessionId = docSnap.id;
    const userRef = sessionRef.parent.parent;
    const clientUid = userRef?.id;
    if (!clientUid) continue;

    if (session.reminderNotificationSent === true) {
      logger.info("Rappel déjà envoyé, ignoré", { sessionId, clientUid });
      continue;
    }
    if (isCancelledSession(session) || isCompletedSession(session)) continue;

    const due = sessionBalanceDue(session);
    const body = due > 0
      ? `Votre session est prévue demain. Solde dû : ${due.toFixed(2).replace('.', ',')} €.`
      : "Votre session est prévue demain. Aucun solde dû pour le moment.";

    const payload = getMessagePayload({ title: "Clean’ App", body, url: WEBAPP_URL });
    const pushResult = await sendPushToUser(clientUid, payload);

    await sessionRef.set({
      reminderNotificationSent: true,
      reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
      reminderBalanceDue: due,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    logger.info("Rappel session demain envoyé", { sessionId, clientUid, due, sent: pushResult.sent, failed: pushResult.failed });
  }
});
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
