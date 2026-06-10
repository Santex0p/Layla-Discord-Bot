import { Model, Recognizer } from 'vosk';

console.log("Loading model...");
const model = new Model('t:/bots/Layla/vosk-model');
const rec = new Recognizer({ model: model, sampleRate: 16000 });
console.log("Model loaded successfully!");
process.exit(0);
