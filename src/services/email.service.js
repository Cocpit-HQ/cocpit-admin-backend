const { Resend } = require('resend');

let resend;
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
} else {
  console.warn('⚠️ RESEND_API_KEY is not defined. Email service running in stub mode.');
}

/**
 * Sends a suspension appeal email to a user with single-use secure token
 * @param {string} email - User email
 * @param {string} fullName - User display name
 * @param {string} appealToken - Secure hex token
 * @param {string} actionReason - Reason for suspension
 */
const sendSuspensionAppealEmail = async (email, fullName, appealToken, actionReason) => {
  if (!resend) {
    console.warn(`[Email Stub] Would send suspension email to ${email} with token: ${appealToken}`);
    return;
  }

  const backendUrl = process.env.MAIN_API_URL || process.env.API_URL || 'http://localhost:5000';
  const appealLink = `${backendUrl}/appeal.html?token=${appealToken}`;

  try {
    const { data, error } = await resend.emails.send({
      from: 'Cocpit <noreply@cocpit.in>',
      to: [email],
      subject: 'Notice: Your Cocpit account has been suspended',
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 560px; margin: 0 auto;">
          <div style="background: #e11d48; padding: 24px 32px; border-radius: 8px 8px 0 0;">
            <h2 style="color: #ffffff; margin: 0; font-size: 22px;">Cocpit Safety & Moderation</h2>
          </div>
          <div style="background: #f9f9f9; padding: 32px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0;">
            <h3 style="margin-top: 0;">Hi ${fullName || 'there'},</h3>
            <p>Your Cocpit account has been suspended for the following reason:</p>
            <blockquote style="background: #fff0f2; border-left: 4px solid #e11d48; padding: 12px 16px; color: #9f1239; margin: 16px 0;">
              ${actionReason}
            </blockquote>
            <p>If you believe this was an error, you have the right to appeal this decision. You can submit an appeal using the secure link below.</p>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${appealLink}"
                 style="background: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">
                Submit an Appeal
              </a>
            </div>
            <p style="font-size: 13px; color: #888;">This link expires in 7 days and can only be used once.</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
            <p style="font-size: 12px; color: #aaa; text-align: center;">© ${new Date().getFullYear()} Cocpit. All rights reserved.</p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error('Resend error (suspension email):', error);
      throw new Error(error.message || 'Failed to send suspension email');
    }

    return data;
  } catch (err) {
    console.error('Failed to send suspension email to:', email, err);
    throw err;
  }
};

module.exports = {
  sendSuspensionAppealEmail,
};
