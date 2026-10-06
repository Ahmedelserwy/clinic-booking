import { PageQuery } from './pagination.model';

export type Gender = 'Male' | 'Female';

export const GENDERS: Gender[] = ['Male', 'Female'];

/** Whole-years age from an ISO date-of-birth string. */
export function calculateAge(dateOfBirth: string | null | undefined, now: Date = new Date()): number | null {
  if (!dateOfBirth) {
    return null;
  }
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) {
    return null;
  }
  let age = now.getFullYear() - dob.getFullYear();
  const monthDelta = now.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age;
}

export interface Patient {
  id: number;
  name: string;
  phone: string;
  dateOfBirth: string;
  gender: Gender | string;
}

export interface CreatePatientRequest {
  id?: number;
  name: string;
  phone: string;
  dateOfBirth: string;
  gender: Gender | string;
}

export interface UpdatePatientRequest {
  id: number;
  name: string;
  phone: string;
  dateOfBirth: string;
  gender: Gender | string;
}

export interface PatientQuery extends PageQuery {
  age?: number;
}
