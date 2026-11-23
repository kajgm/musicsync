// Prints a bcrypt hash for ADMIN_PASSWORD_HASH. Asks for the password without echoing it,
// or reads it from stdin when piped.  Usage: npm run hash-password
import bcrypt from 'bcryptjs';

async function readPassword(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write('Admin password: ');
  stdin.setRawMode(true);
  let password = '';
  for await (const chunk of stdin) {
    for (const ch of String(chunk)) {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        process.stderr.write('\n');
        return password;
      }
      if (ch === '\u0003') process.exit(130); // Ctrl+C
      password = ch === '\u007f' || ch === '\b' ? password.slice(0, -1) : password + ch;
    }
  }
  return password;
}

const password = await readPassword();
if (password.length < 8) {
  console.error('Use at least 8 characters.');
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 12));
