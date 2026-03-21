import axios from 'axios';

export class EmailService {
  static async sendEmail(params: {
    from: string;
    to: string;
    smtp: string;
    port: number;
    pass: string;
    subject: string;
    text: string;
  }) {
    // We can call our own API or use nodemailer directly since we are on the server
    // Let's use the API logic directly here to avoid external HTTP call to self
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: params.smtp,
      port: params.port,
      secure: params.port === 465,
      auth: {
        user: params.from,
        pass: params.pass,
      },
    });

    return transporter.sendMail({
      from: params.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
    });
  }
}
