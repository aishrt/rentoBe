import { EmailButton, EmailHeading, EmailLayout, EmailText } from '../components/email-layout.js';

export interface WelcomeEmailProps {
  firstName: string;
  browseUrl: string;
}

export function WelcomeEmail({ firstName, browseUrl }: WelcomeEmailProps) {
  return (
    <EmailLayout preview="Your Rento Vroom account is ready.">
      <EmailHeading>Kia ora, {firstName}</EmailHeading>
      <EmailText>
        Welcome to Rento Vroom. You can now rent cars from local owners across New Zealand, or share your own
        car when you're not using it.
      </EmailText>
      <EmailButton href={browseUrl}>Explore Rento Vroom</EmailButton>
      <EmailText>If you didn't create this account, you can ignore this email.</EmailText>
    </EmailLayout>
  );
}
