const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { GoogleGenAI } = require("@google/genai");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const geminiApiKey = defineSecret("GEMINI_API_KEY");

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

exports.sendTestNotification = onCall(
  { region: "europe-west1" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Connexion requise.");
    const uid = String(request.data?.uid || "").trim();
    if (!uid) throw new HttpsError("invalid-argument", "uid manquant.");
    if (uid !== request.auth.uid) {
      // TODO: autoriser ici les admins selon la convention du projet.
      throw new HttpsError("permission-denied", "Vous pouvez envoyer un test uniquement à votre compte.");
    }

    const tokensSnap = await admin.firestore().collection("users").doc(uid).collection("notificationTokens").get();
    const tokens = tokensSnap.docs.map((doc) => doc.id).filter(Boolean);
    if (!tokens.length) return { sent: 0 };

    const invalid = [];
    let sent = 0;
    await Promise.all(tokens.map(async (token) => {
      try {
        await admin.messaging().send({
          token,
          notification: { title: "Clean’ App", body: "Les notifications sont bien activées." },
          webpush: { fcmOptions: { link: "https://clean-app-5de06.web.app/" } }
        });
        sent += 1;
      } catch (error) {
        const code = error?.errorInfo?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) invalid.push(token);
      }
    }));

    await Promise.all(invalid.map((token) =>
      admin.firestore().collection("users").doc(uid).collection("notificationTokens").doc(token).delete()
    ));
    return { sent, invalidRemoved: invalid.length };
  }
);
