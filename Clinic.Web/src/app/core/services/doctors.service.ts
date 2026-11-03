import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { CreateDoctorRequest, Doctor, DoctorQuery, UpdateDoctorRequest } from '../models/doctor.model';
import { Pagination } from '../models/pagination.model';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class DoctorsService {
  private readonly api = inject(ApiService);
    
  getDoctors(query: DoctorQuery = {}): Observable<Pagination<Doctor>> {
    return this.api.get<Pagination<Doctor>>('Doctors', {
      PageIndex: query.pageIndex,
      PageSize: query.pageSize,
      Search: query.search,
      Specialty: query.specialty,
      Sort: query.sort
    });
  }

  getDoctor(id: number): Observable<Doctor> {
    return this.api.get<Doctor>(`Doctors/${id}`);
  }

  /**
   * Creates the doctor and their whole working week in one request.
   *
   * The API writes both in a single transaction, so this must NOT be split into
   * a create followed by one call per shift: a shift that failed halfway would
   * leave a doctor with a partial rota and nothing to roll back with.
   */
  createDoctor(payload: CreateDoctorRequest): Observable<Doctor> {
    return this.api.post<Doctor>('Doctors', payload);
  }

  updateDoctor(id: number, payload: UpdateDoctorRequest): Observable<Doctor> {
    return this.api.put<Doctor>(`Doctors/${id}`, payload);
  }

  deleteDoctor(id: number): Observable<void> {
    return this.api.delete<void>(`Doctors/${id}`);
  }
  
}

