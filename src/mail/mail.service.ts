import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import { MailTemplate, templates } from './mail.templates.js';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly appName: string;
  private readonly logoUrl: string;

  constructor(private readonly config: ConfigService) {
    const port = Number(config.get('SMTP_PORT') ?? 587);
    this.transporter = nodemailer.createTransport({
      host: config.getOrThrow('SMTP_HOST'),
      port,
      secure: port === 465,
      auth: { user: config.get('SMTP_USER'), pass: config.get('SMTP_PASSWORD') },
    });
    this.appName = config.get('SMTP_FROM_NAME') ?? 'OnlyDeath';
    this.from = `"${this.appName}" <${config.getOrThrow('SMTP_FROM_EMAIL')}>`;
    // FE_URL may list several origins for CORS; the first is the public site
    this.logoUrl = `${config.getOrThrow<string>('FE_URL').split(',')[0]}/brand/logo-black-email.png`;
  }

  async send(to: string, subject: string, template: MailTemplate, context: Record<string, unknown>) {
    await this.transporter.sendMail({
      from: this.from,
      to,
      subject,
      html: templates[template]({ appName: this.appName, logoUrl: this.logoUrl, ...context }),
    });
  }

  /**
   * Fire-and-forget variant for side-effect emails (invoice, status updates):
   * an SMTP outage must not roll back a payment webhook or admin action.
   */
  sendInBackground(
    to: string,
    subject: string,
    template: MailTemplate,
    context: Record<string, unknown>,
  ) {
    this.send(to, subject, template, context).catch((err) =>
      this.logger.error(`Failed to send "${template}" to ${to}: ${err.message}`),
    );
  }
}
