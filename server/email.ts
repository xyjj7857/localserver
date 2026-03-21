import { AppSettings } from "../src/shared/types";
import nodemailer from 'nodemailer';

export class EmailService {
  static async sendNotification(settings: AppSettings) {
    const { from, to, smtp, port, pass } = settings.email;
    const { supaName } = settings.supabase;

    try {
      const transporter = nodemailer.createTransport({
        host: smtp,
        port: port,
        secure: port === 465,
        auth: {
          user: from,
          pass: pass,
        },
      });

      const info = await transporter.sendMail({
        from: from,
        to: to,
        subject: supaName,
        text: supaName,
      });

      return { success: true, messageId: info.messageId };
    } catch (e: any) {
      console.error('[Server] Email Service Error:', e);
      throw e;
    }
  }
}
