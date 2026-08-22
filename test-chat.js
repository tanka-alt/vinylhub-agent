// Lihtne testiskript — väldib terminali jutumärkide/escapingu probleeme.
// Kasutus (teises terminaliaknas, samal ajal kui server esimeses jookseb):
//
//   node test-chat.js "Kas teil on Miles Davis albumeid?"
//
// Kui sõnumit kaasa ei anna, kasutab vaikimisi küsimust.

const message = process.argv.slice(2).join(" ") || "Kas teil on Miles Davis albumeid?";

console.log(`Saadan küsimuse: "${message}"\n`);

try {
  const res = await fetch("http://localhost:3000/webhook/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "test1", chatInput: message }),
  });

  const text = await res.text();
  console.log(`HTTP staatus: ${res.status}\n`);

  try {
    const json = JSON.parse(text);
    console.log("Vastus:", JSON.stringify(json, null, 2));
  } catch {
    console.log("Toores vastus (polnud JSON):", text);
  }
} catch (err) {
  console.error("Päring ebaõnnestus — kas server (esimeses aknas) jookseb pordil 3000?");
  console.error(err);
}
