import { z } from 'zod';

/* The Host's to-do list and maintenance reminders (spec §9). */

export const todoItemSchema = z
  .object({
    kind: z.enum([
      'PAYOUT_SETUP',
      'REQUESTS',
      'CHECK_IN',
      'CONFIRM_HANDOVER',
      'DOCUMENT_EXPIRING',
      'RUC',
      'MAINTENANCE',
      'LISTING_CHANGES',
    ]),
    title: z.string(),
    detail: z.string().optional(),
    link: z.string().meta({ description: 'A website path' }),
    urgent: z.boolean(),
  })
  .meta({ id: 'TodoItem' });

export const todoResponseSchema = z.object({ items: z.array(todoItemSchema) }).meta({ id: 'HostTodo' });

const reminderBase = z.object({
  title: z.string().trim().min(2, { error: 'Say what’s due, e.g. “Service”' }).max(120),
  dueAt: z.iso.date().optional().meta({ description: 'A date, 2026-12-01' }),
  dueOdometer: z.number().int().min(0).max(2_000_000).optional(),
  notes: z.string().trim().max(500).optional(),
});

export const maintenanceInputSchema = z
  .object({
    reminders: z
      .array(
        reminderBase
          .extend({ id: z.string().optional(), done: z.boolean().default(false) })
          .refine((reminder) => reminder.dueAt || reminder.dueOdometer !== undefined, {
            error: 'Choose a date or an odometer reading',
            path: ['dueAt'],
          }),
      )
      .max(20),
  })
  .meta({ id: 'MaintenanceRemindersRequest' });
export type MaintenanceInput = z.infer<typeof maintenanceInputSchema>;

export const maintenanceResponseSchema = z
  .object({
    reminders: z.array(reminderBase.extend({ id: z.string(), doneAt: z.iso.datetime().optional() })),
    latestOdometer: z
      .number()
      .int()
      .nullable()
      .meta({ description: 'From the car’s last check-in or check-out' }),
  })
  .meta({ id: 'MaintenanceReminders' });
