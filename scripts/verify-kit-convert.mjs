// v20.7.16 — smoke test the KIT → Appt convert button is in the built bundle
import fs from 'node:fs';
import path from 'node:path';
const distDir = 'dist/public/assets';
const files = fs.readdirSync(distDir).filter(f => f.startsWith('index-') && f.endsWith('.js'));
if (!files.length) { console.error('no index bundle'); process.exit(1); }
const bundle = fs.readFileSync(path.join(distDir, files[0]), 'utf8');
const checks = [
  ['KitConvertModal function', bundle.includes('KitConvertModal')],
  ['Convert to Appt Set button', bundle.includes('Convert to Appt Set') || bundle.includes('Convert to Appt')],
  ['convert-kit test id', bundle.includes('convert-kit-') || bundle.includes('convertingLeadId') || bundle.includes('convertLead')],
  ['ApptModal reference', bundle.includes('ApptModal')],
  ['contacted_appointment outcome', bundle.includes('contacted_appointment')],
  ['+60 pts label', bundle.includes('+60 pts') || bundle.includes('60 pts')],
];
for (const [name, ok] of checks) console.log((ok?'✅':'❌'), name);
process.exit(checks.every(([,ok]) => ok) ? 0 : 1);
