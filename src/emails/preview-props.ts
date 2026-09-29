import type { EmailTemplateName, EmailTemplateProps } from './index.js';

/**
 * Sample details for every email, for `npm run email:dev` (plan §7). Adding a template to emailTemplates
 * without adding it here is a type error.
 */
export const previewProps: { [Name in EmailTemplateName]: EmailTemplateProps<Name> } = {
  welcome: { firstName: 'Kiri', browseUrl: 'https://www.rentovroom.com/cars' },
  verifyEmail: { firstName: 'Kiri', verifyUrl: 'https://www.rentovroom.com/verify-email?token=preview' },
  resetPassword: { firstName: 'Kiri', resetUrl: 'https://www.rentovroom.com/reset-password?token=preview' },
  passwordChanged: { firstName: 'Kiri', resetUrl: 'https://www.rentovroom.com/forgot-password' },
  confirmEmailChange: {
    firstName: 'Kiri',
    newEmail: 'kiri.new@example.co.nz',
    confirmUrl: 'https://www.rentovroom.com/confirm-email-change?token=preview',
  },
  emailChanged: {
    firstName: 'Kiri',
    newEmail: 'kiri.new@example.co.nz',
    resetUrl: 'https://www.rentovroom.com/forgot-password',
  },
  mfaChanged: {
    firstName: 'Kiri',
    change: 'DEVICE_ADDED',
    deviceName: 'Work phone',
    resetUrl: 'https://www.rentovroom.com/forgot-password',
  },
};
