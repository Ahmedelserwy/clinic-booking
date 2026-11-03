using Clinic.Domain.Entites;
using Clinic.Domain.Entites.Identity;
using Clinic.Domain.Interfaces;
 
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using System.Linq.Expressions;

namespace Clinic.Infrastructure.Data.Context
{
    /// <summary>
    /// The single context for the whole application: clinical records and identity together.
    ///
    /// They used to live in two contexts over two physical databases, which had three consequences:
    ///
    ///   - IUnitOfWork covered only the clinical context, so no operation touching both could be
    ///     atomic without a distributed transaction (MSDTC - unavailable on Azure SQL and painful
    ///     everywhere else). Provisioning a doctor's login and their Doctor record was two
    ///     independent commits with no way to undo the first if the second failed.
    ///   - There was no way to answer "which patient is this logged-in user?", because no foreign
    ///     key could cross the database boundary. That is what blocked resource-based ownership
    ///     checks, and why any authenticated user can currently read any patient's records.
    ///   - Two connection strings, two migration histories and two backup/restore units for one
    ///     logically indivisible dataset.
    /// </summary>
    public class ClinicDbContext : IdentityDbContext<AppUser>
    {
        private readonly ICurrentUser? _currentUser;
        private readonly TimeProvider _timeProvider;

        // MULTI-TENANT: null in tests, in design-time tooling and on unauthenticated requests.
        private readonly ICurrentTenant? _currentTenant;

        /// <summary>
        /// The optional parameters are resolved from DI at runtime. They are optional so that the
        /// many places constructing a context directly - tests, design-time tooling - keep working;
        /// audit columns then record no actor, which is the truthful answer for work with no user.
        /// </summary>
        public ClinicDbContext(
            DbContextOptions<ClinicDbContext> options,
            ICurrentUser? currentUser = null,
            TimeProvider? timeProvider = null,
            ICurrentTenant? currentTenant = null) : base(options)
        {
            _currentUser = currentUser;
            _timeProvider = timeProvider ?? TimeProvider.System;
            _currentTenant = currentTenant;
        }

        /// <summary>
        /// MULTI-TENANT: the tenant every query is filtered by, and the one every insert is
        /// stamped with. Null when no tenant could be resolved.
        ///
        /// Public and instance-level because the query filters built in ApplyTenantQueryFilters
        /// reference THIS PROPERTY, not the value it currently holds. That distinction is the
        /// single most important thing in this file: EF caches the model once per context type, so
        /// a filter that captured the value would freeze the first request's tenant and serve it to
        /// every user of the process thereafter. Referencing the property instead makes EF evaluate
        /// it per query, against the context instance actually running it.
        ///
        /// TenantIsolationTests.Two_Contexts_With_Different_Tenants_See_Different_Data exists
        /// specifically to prove that, because the failure mode is silent and catastrophic.
        /// </summary>
        public int? CurrentTenantId => _currentTenant?.TenantId;

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            // Required: this is what maps AspNetUsers, AspNetRoles and the rest. Omitting it leaves
            // Identity silently unmapped.
            base.OnModelCreating(modelBuilder);

            modelBuilder.ApplyConfigurationsFromAssembly(typeof(ClinicDbContext).Assembly);

            // Applied to every entity rather than repeated per configuration class, so a new entity
            // cannot be added without concurrency protection.
            foreach (var entityType in modelBuilder.Model.GetEntityTypes()
                         .Where(e => typeof(BaseEntity).IsAssignableFrom(e.ClrType)))
            {
                var entity = modelBuilder.Entity(entityType.ClrType);

                // IsConcurrencyToken puts the ORIGINAL value into the WHERE clause of every UPDATE
                // and DELETE. If another transaction changed the row first, zero rows match and EF
                // raises DbUpdateConcurrencyException instead of silently overwriting.
                entity.Property(nameof(BaseEntity.RowVersion)).IsConcurrencyToken();

                entity.Property(nameof(BaseEntity.CreatedBy)).HasMaxLength(450);   // Identity key length
                entity.Property(nameof(BaseEntity.ModifiedBy)).HasMaxLength(450);
            }

            ConfigureIdentityLinks(modelBuilder);

            // MULTI-TENANT: gives every ITenantEntity its foreign key and index.
            ConfigureTenantLinks(modelBuilder);

            // MULTI-TENANT: and this is what actually isolates the data.
            ApplyTenantQueryFilters(modelBuilder);

            // Last, so it also covers anything the configuration classes above introduced.
            ForceUtcOnDateTimeProperties(modelBuilder);
        }

        /// <summary>
        /// Guarantees every DateTime handed to Npgsql carries Kind = Utc.
        ///
        /// Npgsql maps DateTime to 'timestamp with time zone' and flatly REFUSES a value whose Kind
        /// is Unspecified or Local - it throws rather than guessing an offset. Model binding a JSON
        /// payload such as "2026-08-10T09:00:00" produces Kind = Unspecified every time, so without
        /// this every appointment write would fail. SQL Server's datetime2 ignored Kind entirely,
        /// which is why this only appeared after the PostgreSQL port and why nothing caught it.
        ///
        /// Applied over the whole model rather than to the three known Appointment properties, so a
        /// DateTime added later cannot reintroduce the bug.
        ///
        /// Store type is unchanged - DateTime in, DateTime out - so this alters no column and needs
        /// no migration.
        /// </summary>
        private static void ForceUtcOnDateTimeProperties(ModelBuilder modelBuilder)
        {
            // Unspecified is RELABELLED, not converted: the value is already the intended UTC
            // instant, and calling ToUniversalTime() on it would have .NET treat it as server-local
            // and shift it by the host's offset - silently moving appointments by hours depending on
            // where the process happens to run. A genuinely Local value is converted properly.
            var utc = new ValueConverter<DateTime, DateTime>(
                toDb => toDb.Kind == DateTimeKind.Utc
                    ? toDb
                    : toDb.Kind == DateTimeKind.Local
                        ? toDb.ToUniversalTime()
                        : DateTime.SpecifyKind(toDb, DateTimeKind.Utc),
                fromDb => DateTime.SpecifyKind(fromDb, DateTimeKind.Utc));

            var nullableUtc = new ValueConverter<DateTime?, DateTime?>(
                toDb => !toDb.HasValue
                    ? toDb
                    : toDb.Value.Kind == DateTimeKind.Utc
                        ? toDb
                        : toDb.Value.Kind == DateTimeKind.Local
                            ? toDb.Value.ToUniversalTime()
                            : DateTime.SpecifyKind(toDb.Value, DateTimeKind.Utc),
                fromDb => fromDb.HasValue
                    ? DateTime.SpecifyKind(fromDb.Value, DateTimeKind.Utc)
                    : fromDb);

            foreach (var property in modelBuilder.Model.GetEntityTypes().SelectMany(e => e.GetProperties()))
            {
                // DateTimeOffset carries its own offset and is already unambiguous - leave it alone.
                if (property.ClrType == typeof(DateTime))
                    property.SetValueConverter(utc);
                else if (property.ClrType == typeof(DateTime?))
                    property.SetValueConverter(nullableUtc);
            }
        }

        /// <summary>
        /// Links clinical records to the account that represents the same person.
        ///
        /// A real foreign key, only possible now that both live in one database. Deliberately no
        /// navigation property: the clinical entities should not have to know what an AppUser is,
        /// and an ownership check only ever needs the identifier.
        /// </summary>
        private static void ConfigureIdentityLinks(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Patient>(patient =>
            {
                patient.Property(p => p.UserId).HasMaxLength(450);
                patient.HasIndex(p => p.UserId);

                patient.HasOne<AppUser>()
                       .WithMany()
                       .HasForeignKey(p => p.UserId)
                       // Removing a login must not erase the clinical record it pointed at.
                       .OnDelete(DeleteBehavior.SetNull);
            });

            modelBuilder.Entity<Doctor>(doctor =>
            {
                doctor.Property(d => d.UserId).HasMaxLength(450);
                doctor.HasIndex(d => d.UserId);

                doctor.HasOne<AppUser>()
                      .WithMany()
                      .HasForeignKey(d => d.UserId)
                      .OnDelete(DeleteBehavior.SetNull);
            });
        }

        /// <summary>
        /// MULTI-TENANT: gives every <see cref="ITenantEntity"/> a real foreign key to its tenant
        /// and an index on it.
        ///
        /// Driven by scanning the model for the marker interface rather than repeated in each
        /// configuration class - the same approach, and for the same reason, as the RowVersion loop
        /// in OnModelCreating: a tenant-owned entity added later cannot be added WITHOUT this. A
        /// hand-maintained list of type names somewhere in Infrastructure is exactly the thing that
        /// goes stale, and going stale here means a table with no tenant column and no isolation.
        ///
        /// DeleteBehavior.Restrict, emphatically not Cascade. Cascade would mean deleting one
        /// Tenant row silently destroys every doctor, patient, appointment and schedule belonging to
        /// that clinic - an entire practice's clinical history, from a single DELETE, with no
        /// confirmation anywhere. Restrict makes the database refuse instead, so removing a tenant
        /// has to be a deliberate, explicit act rather than a footgun.
        ///
        /// No navigation property on either side: the relationship is expressed from the dependent
        /// side only, exactly as ConfigureIdentityLinks does for Patient/Doctor to AppUser. The
        /// filter and the stamping both key on the TenantId value, and neither needs to traverse a
        /// navigation to reach it.
        /// </summary>
        private static void ConfigureTenantLinks(ModelBuilder modelBuilder)
        {
            foreach (var entityType in modelBuilder.Model.GetEntityTypes()
                         .Where(e => typeof(ITenantEntity).IsAssignableFrom(e.ClrType)))
            {
                var entity = modelBuilder.Entity(entityType.ClrType);

                entity.HasOne(typeof(Tenant))
                      .WithMany()
                      .HasForeignKey(nameof(ITenantEntity.TenantId))
                      .OnDelete(DeleteBehavior.Restrict);

                // PostgreSQL does not index a referencing column automatically, and every query in
                // the application filters on this one.
                //
                // Skipped when a configuration class has already declared an index LEADING with
                // TenantId - a composite such as (TenantId, IsActive) serves every lookup a
                // standalone (TenantId) would, because a B-tree can be searched on any prefix of
                // its key. Adding both would mean maintaining two structures on every insert,
                // update and delete to answer one question.
                //
                // This runs after ApplyConfigurationsFromAssembly, so the composites declared in
                // DoctorConfig and DoctorScheduleConfig are already visible here.
                var alreadyIndexedByTenant = entityType.GetIndexes()
                    .Any(index => index.Properties[0].Name == nameof(ITenantEntity.TenantId));

                if (!alreadyIndexedByTenant)
                {
                    entity.HasIndex(nameof(ITenantEntity.TenantId));
                }
            }

            // AppUser is handled here rather than by the loop above, because it deliberately does
            // NOT implement ITenantEntity - see the note on AppUser.TenantId. It gets the column
            // and the foreign key, so an account's clinic is a real, referentially-enforced fact,
            // but it gets no query filter: Identity looks accounts up before any tenant is known,
            // and a filter would make every sign-in fail.
            //
            // Nullable, and staying nullable: the seeded administrator belongs to no single clinic,
            // and forcing a tenant onto it would break the existing seeding path.
            modelBuilder.Entity<AppUser>(user =>
            {
                user.HasOne<Tenant>()
                    .WithMany()
                    .HasForeignKey(u => u.TenantId)
                    .OnDelete(DeleteBehavior.Restrict);

                user.HasIndex(u => u.TenantId);
            });
        }

        /// <summary>
        /// MULTI-TENANT: filters every <see cref="ITenantEntity"/> to the current tenant.
        ///
        /// This is what makes `context.Doctors` mean `context.Doctors.Where(d => d.TenantId == me)`
        /// without a single query, repository or specification having to say so. EF applies the
        /// filter at the QUERY ROOT, before anything a specification adds, so Include, ThenInclude,
        /// Where, OrderBy, Skip and Take all compose on top of an already-isolated set. That is why
        /// the Specification pattern needed no changes at all - and why a developer writing a new
        /// specification cannot forget to isolate it.
        ///
        /// Built by reflecting over the marker interface rather than one HasQueryFilter call per
        /// entity, for the reason that matters most here: a tenant-owned entity added next year is
        /// filtered the day it is added, by someone who has never read this file.
        ///
        /// NOT static, and deliberately so - see CurrentTenantId. The expression closes over this
        /// context's PROPERTY, not over a value, which is what keeps the cached model correct
        /// across requests with different tenants.
        ///
        /// A null tenant matches nothing: TenantId is non-nullable in the database, so
        /// `TenantId = NULL` is never true and the caller sees an empty result. Failing closed is
        /// the entire point - a request that somehow loses its claim shows an empty screen instead
        /// of another clinic's patients.
        /// </summary>
        private void ApplyTenantQueryFilters(ModelBuilder modelBuilder)
        {
            // The property access is built ONCE and shared by every filter: Expression.Constant(this)
            // captures this context, and EF's parameter extraction substitutes the context actually
            // executing the query. Comparing as int? rather than int is what makes an unresolved
            // tenant match no row instead of throwing.
            var currentTenantId = Expression.Property(
                Expression.Constant(this),
                nameof(CurrentTenantId));

            foreach (var entityType in modelBuilder.Model.GetEntityTypes()
                         .Where(e => typeof(ITenantEntity).IsAssignableFrom(e.ClrType)))
            {
                var entity = Expression.Parameter(entityType.ClrType, "entity");

                var body = Expression.Equal(
                    Expression.Convert(
                        Expression.Property(entity, nameof(ITenantEntity.TenantId)),
                        typeof(int?)),
                    currentTenantId);

                modelBuilder.Entity(entityType.ClrType)
                            .HasQueryFilter(Expression.Lambda(body, entity));
            }
        }

        public override Task<int> SaveChangesAsync(CancellationToken cancellationToken = default)
        {
            StampAuditColumns();
            StampTenantId();
            return base.SaveChangesAsync(cancellationToken);
        }

        public override int SaveChanges()
        {
            StampAuditColumns();
            StampTenantId();
            return base.SaveChanges();
        }

        /// <summary>
        /// MULTI-TENANT: assigns the owning tenant on insert, and forbids it changing afterwards.
        ///
        /// Centralised here for exactly the reason StampAuditColumns is: anything a caller has to
        /// remember, some caller eventually forgets - and forgetting this one produces a record
        /// owned by the wrong clinic, or by none.
        ///
        /// Two rules:
        ///
        ///   Added, tenant resolved      - overwrite unconditionally. Not "fill in if missing":
        ///                                 overwriting is what guarantees a request cannot plant a
        ///                                 record inside another clinic, whatever reached the
        ///                                 entity beforehand. Belt and braces with the AutoMapper
        ///                                 ignore, which stops a request body getting this far.
        ///
        ///   Added, tenant NOT resolved  - honour an explicitly assigned tenant, and throw when
        ///                                 there is none. That covers seeding, tests and background
        ///                                 work, which legitimately have no ambient tenant but do
        ///                                 know which clinic they are writing for. Throwing beats
        ///                                 writing 0: the failure names the problem, instead of
        ///                                 surfacing later as a foreign key violation that names a
        ///                                 constraint.
        ///
        /// Modified - the tenant is frozen. Moving a record between clinics is not an edit, and an
        /// update path that could do it silently would undo every read filter in the application.
        /// Same mechanism the audit columns use to protect CreatedBy.
        /// </summary>
        private void StampTenantId()
        {
            var tenantId = CurrentTenantId;

            foreach (var entry in ChangeTracker.Entries<ITenantEntity>())
            {
                switch (entry.State)
                {
                    case EntityState.Added:
                        if (tenantId.HasValue)
                        {
                            entry.Entity.TenantId = tenantId.Value;
                        }
                        else if (entry.Entity.TenantId == 0)
                        {
                            throw new InvalidOperationException(
                                $"Cannot save a {entry.Entity.GetType().Name} because no tenant could be " +
                                "resolved for this operation and none was assigned explicitly. A tenant-owned " +
                                "record must belong to a clinic: either perform the write on an authenticated " +
                                "request whose token carries a tenant claim, or set TenantId explicitly for " +
                                "seeding and background work.");
                        }
                        break;

                    case EntityState.Modified:
                        // Assigning nothing and marking it unmodified leaves the loaded value in
                        // place AND keeps it out of the UPDATE statement entirely.
                        entry.Property(nameof(ITenantEntity.TenantId)).IsModified = false;
                        break;
                }
            }
        }

        /// <summary>
        /// Maintains the audit columns and rotates the concurrency token.
        ///
        /// Centralised here rather than in each controller for the usual reason: anything a caller
        /// has to remember to do, some caller eventually forgets. Doing it in the context means
        /// every write is covered, including ones added later.
        /// </summary>
        private void StampAuditColumns()
        {
            var now = _timeProvider.GetUtcNow();
            var actor = _currentUser?.UserId;

            foreach (var entry in ChangeTracker.Entries<BaseEntity>())
            {
                switch (entry.State)
                {
                    case EntityState.Added:
                        entry.Entity.CreatedAtUtc = now;
                        entry.Entity.CreatedBy = actor;
                        entry.Entity.RowVersion = Guid.NewGuid();
                        break;

                    case EntityState.Modified:
                        entry.Entity.ModifiedAtUtc = now;
                        entry.Entity.ModifiedBy = actor;

                        // Assigning a new value leaves the ORIGINAL value untouched, which is what
                        // EF puts in the WHERE clause - so the check still tests what was loaded.
                        entry.Entity.RowVersion = Guid.NewGuid();

                        // Creation provenance is written once. Update() marks every property
                        // modified, so without this an update would happily rewrite who created the
                        // record and when.
                        entry.Property(e => e.CreatedAtUtc).IsModified = false;
                        entry.Property(e => e.CreatedBy).IsModified = false;
                        break;
                }
            }
        }

        // MULTI-TENANT: the tenant roster. Global - no query filter - because a tenant cannot be
        // filtered by itself, and because the tenant-creation endpoint has to be able to see the
        // rows it creates.
        public DbSet<Tenant> Tenants { get; set; }

        public DbSet<Patient> Patients { get; set; }
        public DbSet<Doctor> Doctors { get; set; }
        public DbSet<DoctorSchedule> DoctorSchedules { get; set; }
        public DbSet<Appointment> Appointments { get; set; }

        // Clinic running costs (rent, utilities, salaries...). Tenant-owned: ITenantEntity gives it
        // the query filter, the TenantId foreign key and the insert-time stamping automatically.
        public DbSet<Expense> Expenses { get; set; }
        public DbSet<Payment> Payments { get; set; }
        public DbSet<DailyClosing> DailyClosings { get; set; }

        // There is deliberately no DbSet<User>. The legacy Clinic.Domain.Entites.User entity
        // defined a plaintext 'Password' column and was entirely superseded by ASP.NET Identity
        // (AppUser / AspNetUsers). It was referenced by no code, but a schema that invites plaintext
        // credential storage is an accident waiting for the next developer who finds the column.
        // Removed in TODO #15 (finding H17); RemoveLegacyUserTable drops the table.
    }
}
