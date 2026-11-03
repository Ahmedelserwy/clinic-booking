import { Injectable, computed } from '@angular/core';

import { BadgeTone } from '../../shared/ui/data-table/data-table.model';
import { IconName } from '../../shared/ui/icon/icon.registry';
import { Identified, LocalCollection, newId } from './local-collection';

export type RecordType = 'visit' | 'checkup';

export interface Vitals {
  bloodPressure?: string;
  temperature?: number;
  pulse?: number;
  weight?: number;
  /** Random blood sugar, mg/dL - routine in general / internal medicine clinics. */
  bloodSugar?: number;
  /** Oxygen saturation, %. */
  oxygenSaturation?: number;
}

/** One line of the prescription, the way a doctor writes it: drug, how to take it, for how long. */
export interface Medication {
  /** Trade name as written on the box. */
  name: string;
  /** Free text, e.g. "1 tablet x 3 daily after meals". */
  dosage?: string;
  /** Free text, e.g. "1 week" or "ongoing". */
  duration?: string;
}

export interface MedicalRecord extends Identified {
  patientId: number;
  patientName: string;
  doctorId?: number;
  doctorName?: string;
  type: RecordType;
  /** ISO date-time of the clinical event, not of data entry. */
  occurredAt: string;
  /** Free clinical text - never translated. */
  title: string;
  complaint?: string;
  /** Clinical examination findings. */
  examination?: string;
  diagnosis?: string;
  /** Lab tests and imaging requested at this visit. */
  requestedTests?: string;
  /** Instructions given to the patient (stored under its original name). */
  treatment?: string;
  /**
   * The prescription as printable plain text. Always derived from `medications`
   * plus `prescriptionNote` when the record is saved, so every screen that only
   * shows text keeps working - and so records saved before `medications`
   * existed still read correctly.
   */
  prescription?: string;
  /** Structured prescription lines; the source of truth for `prescription`. */
  medications?: Medication[];
  /** Free-text addition to the prescription (or the old single-text prescription). */
  prescriptionNote?: string;
  /** ISO date (yyyy-MM-dd) of the planned follow-up visit. */
  followUpDate?: string;
  vitals?: Vitals;
  tags: string[];
  recordedBy: string;
  createdAt: string;
}

/** Presentation metadata per entry type, shared by the timeline and the table. */
export const RECORD_TYPE_META: Record<
  RecordType,
  { label: string; icon: IconName; tone: BadgeTone }
> = {
  visit: { label: 'records.typeVisit', icon: 'visit', tone: 'primary' },
  checkup: { label: 'records.typeCheckup', icon: 'records', tone: 'info' },
};

export const RECORD_TYPES = Object.keys(RECORD_TYPE_META) as RecordType[];

/**
 * The clinical history.
 *
 * Records are immutable in spirit - an entry describes what was observed at a
 * point in time - so `occurredAt` is separate from `createdAt`: a doctor
 * writing up yesterday's visit this morning must not have it filed under today.
 */
@Injectable({ providedIn: 'root' })
export class MedicalRecordsStore {
  private readonly collection = new LocalCollection<MedicalRecord>({
    key: 'medical-records',
    // Still 2: every field added since is optional, so stored entries remain
    // valid. Bump only when a stored `type` stops existing in RECORD_TYPE_META,
    // which would crash every screen that renders its badge.
    version: 2,
    seed: () => [],
    searchFields: ['title', 'patientName', 'diagnosis', 'complaint', 'prescription'],
  });

  /** Newest clinical event first. */
  readonly records = computed(() =>
    [...this.collection.all()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  );

  readonly count = this.collection.count;

  forPatient(patientId: number): MedicalRecord[] {
    return this.records().filter((record) => record.patientId === patientId);
  }

  getById(id: string): MedicalRecord | undefined {
    return this.collection.getById(id);
  }

  create(input: Omit<MedicalRecord, 'id' | 'createdAt'>): MedicalRecord {
    return this.collection.insert({
      ...input,
      id: newId('rec'),
      createdAt: new Date().toISOString(),
    });
  }

  update(id: string, patch: Partial<MedicalRecord>): void {
    this.collection.update(id, patch);
  }

  remove(id: string): void {
    this.collection.remove(id);
  }

  /** Called when a patient is deleted so records cannot outlive their subject. */
  removeForPatient(patientId: number): number {
    return this.collection.removeWhere((record) => record.patientId === patientId);
  }
}