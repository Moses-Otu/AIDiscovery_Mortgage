export interface OutgoingEmail { to: string; subject: string; text: string }
export interface Mailer { send(email: OutgoingEmail): Promise<void> }

// Development mailer: keeps messages in memory and logs the link. Replace with a real provider.
export class DevOutboxMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  constructor(private log = false) {}
  async send(email: OutgoingEmail) {
    this.sent.push(email);
    if (this.log) console.log(`[mail] to=${email.to} subject="${email.subject}"\n${email.text}\n`);
  }
}
