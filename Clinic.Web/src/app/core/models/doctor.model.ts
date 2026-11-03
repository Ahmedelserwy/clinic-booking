import { SPECIALTY_STORED_VALUES } from '../i18n/specialty';
import { DoctorServiceItem, ReexaminationPolicy } from '../services/Doctor service.model';
import { PageQuery } from './pagination.model';
import { WeekDay } from './schedule.model';

export interface Doctor {
  id: number;
  name: string;
  specialization: string;
  email?: string;
  phone?: string;
  bio?: string;
  rating?: number;
  consultationFee?: number;
  isActive?: boolean;
  imageUrl?: string;
  services?: DoctorServiceItem[];
  reexamination?: ReexaminationPolicy | null;
}

/**
 * One shift on the rota, as sent alongside a new doctor.
 *
 * No `doctorId`: the doctor does not exist yet when this is composed, and the
 * API assigns the key inside the same transaction that writes these rows.
 */
export interface DoctorShiftRequest {
  weekDay: WeekDay;
  /** `HH:mm:ss` — the shape the API's `TimeOnly` binder expects. */
  startTime: string;
  endTime: string;
}

export interface CreateDoctorRequest {
  name: string;
  specialization: string;
  phone?: string | null;
  email?: string | null;
  consultationFee?: number | null;
  bio?: string | null;
  isActive: boolean;
  /** Empty is legitimate: a doctor may be registered before their rota is agreed. */
  schedules: DoctorShiftRequest[];
  services?: DoctorServiceItem[];
  reexamination?: ReexaminationPolicy | null;
}

export interface UpdateDoctorRequest {
  id: number;
  name: string;
  specialization: string;
  phone?: string | null;
  email?: string | null;
  consultationFee?: number | null;
  bio?: string | null;
  isActive: boolean;
  services?: DoctorServiceItem[];
  reexamination?: ReexaminationPolicy | null;
}

export interface DoctorQuery extends PageQuery {
  specialty?: string;
}

/**
 * The specialities offered when adding a doctor.
 *
 * Re-exported from the localisation module rather than listed again here: these
 * are exactly the values `core/i18n/specialty.ts` can translate, and a second
 * hand-maintained list would eventually offer a speciality that renders as a raw
 * English string in Arabic.
 *
 * The column stays free text — a clinic can still type its own — so nothing here
 * invalidates existing data.
 */
export const DEFAULT_SPECIALIZATIONS = SPECIALTY_STORED_VALUES;