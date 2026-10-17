module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    project: "Raging Angels MC",
    hosting: "Vercel",
    features: {
      clubhouseWebsite: true,
      visitorLocalClock: true,
      chaptersDashboard: "frontend scaffold",
      presidentControls: "frontend scaffold",
      realtimeChapelAudio: false,
      translatedSpeechAudio: false,
      persistentMemberData: false
    },
    note: "Realtime audio, translated speech, authentication, and persistent storage require their service integrations to be configured before they can be called live."
  });
};
