const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SOURCE = path.join(__dirname, 'src', 'Mog.user.js');
const OUTPUT = path.join(__dirname, 'dist', 'Mog.user.js');

// --- 1. Ler source ---
const source = fs.readFileSync(SOURCE, 'utf-8');

// --- 2. Separar header do body ---
const headerStart = source.indexOf('// ==UserScript==');
const headerEnd = source.indexOf('// ==/UserScript==');

if (headerStart === -1 || headerEnd === -1) {
  console.error('❌ Header do UserScript não encontrado!');
  process.exit(1);
}

const headerEndPos = source.indexOf('\n', headerEnd) + 1;
const header = source.slice(headerStart, headerEndPos);
const body = source.slice(headerEndPos);

console.log(`📄 Source: ${SOURCE}`);
console.log(`📦 Body: ${body.length.toLocaleString()} caracteres`);
console.log('🔒 Ofuscando...\n');

// --- 3. Ofuscar o body ---
const obfuscated = JavaScriptObfuscator.obfuscate(body, {
  // Compacta em uma linha
  compact: true,

  // Controle de fluxo: embaralha a ordem de execução
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,

  // Injeta código morto pra confundir
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,

  // Desativa mensagens de debug
  debugProtection: false,

  // Bloqueia ferramentas de dev (desligado pra não travar o jogo)
  disableConsoleOutput: false,

  // Renomeia identificadores
  identifierNamesGenerator: 'hexadecimal',

  // Ofusca logs
  log: false,

  // Muda nomes de variáveis em escopos internos
  renameGlobals: false,

  // Codifica strings em array com RC4
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.75,
  stringArrayEncoding: ['rc4'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,

  // Self-defending: se o código for "beautified", ele quebra
  selfDefending: true,

  // Transforma objetos
  transformObjectKeys: true,

  // Unicode escape sequences
  unicodeEscapeSequence: false,

  // Seed fixa pra builds reproduzíveis (opcional, remova pra aleatoriedade total)
  // seed: 42,

  // Target
  target: 'browser',
});

// --- 4. Combinar header + body ofuscado ---
const result = header + '\n' + obfuscated.getObfuscatedCode();

// --- 5. Escrever output ---
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, result, 'utf-8');

const originalSize = (source.length / 1024).toFixed(1);
const finalSize = (result.length / 1024).toFixed(1);

console.log(`✅ Build concluído!`);
console.log(`   📄 Original: ${originalSize} KB`);
console.log(`   🔒 Ofuscado: ${finalSize} KB`);
console.log(`   📦 Output:   ${OUTPUT}`);
