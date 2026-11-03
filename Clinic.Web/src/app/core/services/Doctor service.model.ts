/**
 * A regular service a doctor provides (examination, consultation, a procedure…),
 * with the price the clinic charges for it.
 */
export interface DoctorServiceItem {
  id?: number | null;
  name: string;
  price: number | null;
  /** Optional; the clinic's default slot length applies when empty. */
  durationMinutes: number | null;
}

/**
 * Re-examination (follow-up) policy of one doctor.
 *
 * A visit counts as a re-examination when the patient returns to the same doctor
 * within `validDays` of the first visit; it is then charged `fee` (0 = free)
 * instead of the regular consultation fee.
 */
export interface ReexaminationPolicy {
  enabled: boolean;
  fee: number | null;
  validDays: number;
}

export const DEFAULT_REEXAMINATION: ReexaminationPolicy = {
  enabled: false,
  fee: 0,
  validDays: 14,
};