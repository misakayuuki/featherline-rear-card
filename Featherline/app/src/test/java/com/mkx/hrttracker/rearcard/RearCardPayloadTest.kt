package com.mkx.hrttracker.rearcard

import com.mkx.hrttracker.model.bloodtest.BloodUnitKey
import com.mkx.hrttracker.model.medication.MedicationGroup
import com.mkx.hrttracker.model.medication.MedicationGroupSchedule
import com.mkx.hrttracker.model.medication.MedicationGroupScheduleType
import com.mkx.hrttracker.model.medication.testMedicationGroupMedication
import com.mkx.hrttracker.model.medication.testMedicationLogEntry
import com.mkx.hrttracker.model.pk.PkConcentrationUnit
import com.mkx.hrttracker.model.pk.PkProjectionResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.util.UUID

class RearCardPayloadTest {
    private val utc = ZoneId.of("UTC")
    private val day = LocalDate.of(2026, 10, 21)

    @Test fun weeklyPlanFindsNextDoseBeyondTomorrow() {
        val plan = group().copy(schedule = MedicationGroupSchedule(
            type = MedicationGroupScheduleType.WEEKLY,
            interval = 1,
            since = day,
            weeklyDaysOfWeek = setOf(DayOfWeek.MONDAY),
            times = listOf(LocalTime.of(9, 0)),
        ))
        val next = RearCardPayload.nextPendingDose(listOf(plan), emptyList(), day.atTime(22, 0), utc)
        assertEquals(Instant.parse("2026-10-26T09:00:00Z"), next?.at)
    }

    @Test fun alreadyFulfilledUpcomingSlotIsSkipped() {
        val plan = group()
        val logged = entry(plan, day.atTime(9, 0), day.atTime(8, 30), count = 1)
        val next = RearCardPayload.nextPendingDose(listOf(plan), listOf(logged), day.atTime(8, 45), utc)
        assertEquals(Instant.parse("2026-10-22T09:00:00Z"), next?.at)
    }

    @Test fun partiallyFulfilledGroupStillNeedsItsScheduledSlot() {
        val plan = group(count = 2)
        val logged = entry(plan, day.atTime(9, 0), day.atTime(8, 30), count = 1)
        val next = RearCardPayload.nextPendingDose(listOf(plan), listOf(logged), day.atTime(8, 45), utc)
        assertEquals(Instant.parse("2026-10-21T09:00:00Z"), next?.at)
    }

    @Test fun outsideWindowRecordIsAddressedLikeOfficialWidget() {
        val plan = group()
        val scheduled = day.atTime(9, 0)
        val logged = entry(plan, scheduled, scheduled.minusHours(13), count = 1)
        val next = RearCardPayload.nextPendingDose(listOf(plan), listOf(logged), day.atTime(8, 45), utc)
        assertEquals(Instant.parse("2026-10-22T09:00:00Z"), next?.at)
    }

    @Test fun exactScheduledInstantIsStillTheNextDose() {
        val next = RearCardPayload.nextPendingDose(listOf(group()), emptyList(), day.atTime(9, 0), utc)
        assertEquals(Instant.parse("2026-10-21T09:00:00Z"), next?.at)
    }

    @Test fun dstGapUsesResolvedInstantInsteadOfDroppingFutureDose() {
        val zone = ZoneId.of("Europe/Berlin")
        val date = LocalDate.of(2026, 3, 29)
        val plan = group().copy(schedule = MedicationGroupSchedule(
            MedicationGroupScheduleType.DAILY, 1, date, emptySet(), listOf(LocalTime.of(2, 30)),
        ))
        val next = RearCardPayload.nextPendingDose(listOf(plan), emptyList(), date.atTime(3, 15), zone)
        assertEquals(Instant.parse("2026-03-29T01:30:00Z"), next?.at)
    }

    @Test fun archivedGroupAndOutOfHorizonPlansAreNotInvented() {
        val archived = group().copy(archivedAtLocal = day.minusDays(1).atStartOfDay())
        assertNull(RearCardPayload.nextPendingDose(listOf(archived), emptyList(), day.atTime(8, 0), utc))
        val distant = group().copy(schedule = group().schedule.copy(
            since = day.plusDays(100),
            timeSlots = group().schedule.timeSlots.map { it.copy(effectiveFrom = day.plusDays(100).atStartOfDay()) },
        ))
        assertNull(RearCardPayload.nextPendingDose(listOf(distant), emptyList(), day.atTime(8, 0), utc))
    }

    @Test fun userDisplayUnitUsesOfficialConversionAndKeepsTrueZero() {
        val curve = projection(values = listOf(0.0, 100.0, 200.0))
        val series = RearCardPayload.displaySeries(curve, BloodUnitKey.PMOL_L,
            curve.windowStart.plusSeconds(3600).toEpochMilli(), curve.windowEnd.toEpochMilli())
        assertNotNull(series)
        assertEquals("pmol/L", series!!.unit)
        assertEquals(0.0, series.values[0], 0.000001)
        assertEquals(367.1, series.values[1], 0.000001)
    }

    @Test fun invalidOrExpiredCurveDoesNotBecomeACurrentEstimate() {
        val curve = projection()
        val now = curve.windowStart.plusSeconds(3600).toEpochMilli()
        assertNull(RearCardPayload.displaySeries(curve.copy(timeH = listOf(0.0, 2.0, 1.0)),
            BloodUnitKey.PG_ML, now, now + 3600000))
        assertNull(RearCardPayload.displaySeries(curve.copy(concentrations = listOf(1.0, Double.NaN, 3.0)),
            BloodUnitKey.PG_ML, now, now + 3600000))
        assertNull(RearCardPayload.displaySeries(curve, BloodUnitKey.PG_ML,
            curve.windowEnd.toEpochMilli(), curve.windowEnd.toEpochMilli() + 3600000))
    }

    @Test fun everyOfficialSourceUnitProducesTheSameDisplayValues() {
        val equivalents = mapOf(
            PkConcentrationUnit.PG_PER_ML to 100.0,
            PkConcentrationUnit.PMOL_PER_L to 367.1,
            PkConcentrationUnit.NG_PER_DL to 10.0,
            PkConcentrationUnit.NG_PER_ML to 0.1,
            PkConcentrationUnit.NMOL_PER_L to 0.3671,
        )
        for ((unit, value) in equivalents) {
            val curve = projection(values = listOf(value, value, value)).copy(concentrationUnit = unit)
            val now = curve.windowStart.plusSeconds(3600).toEpochMilli()
            val pg = RearCardPayload.displaySeries(curve, BloodUnitKey.PG_ML, now, curve.windowEnd.toEpochMilli())
            val ng = RearCardPayload.displaySeries(curve, BloodUnitKey.NG_DL, now, curve.windowEnd.toEpochMilli())
            assertEquals(unit.name, 100.0, pg!!.values[1], 0.000001)
            assertEquals("pg/mL", pg.unit)
            assertEquals(unit.name, 10.0, ng!!.values[1], 0.000001)
            assertEquals("ng/dL", ng.unit)
        }
    }

    @Test fun overflowingConversionDropsEstimateWithoutDiscardingScheduleSummary() {
        for (unit in listOf(PkConcentrationUnit.NG_PER_ML, PkConcentrationUnit.NMOL_PER_L)) {
            val curve = projection(values = List(3) { Double.MAX_VALUE }).copy(concentrationUnit = unit)
            val now = curve.windowStart.plusSeconds(3600).toEpochMilli()
            assertNull(RearCardPayload.displaySeries(curve, BloodUnitKey.PG_ML, now, curve.windowEnd.toEpochMilli()))
        }
    }

    private fun group(count: Int = 1) = MedicationGroup(
        uuid = UUID.randomUUID(),
        name = "Morning plan",
        schedule = MedicationGroupSchedule(MedicationGroupScheduleType.DAILY, 1, day,
            emptySet(), listOf(LocalTime.of(9, 0))),
        medications = listOf(testMedicationGroupMedication(count = count)),
        createdAt = Instant.EPOCH,
        updatedAt = Instant.EPOCH,
    )

    private fun entry(plan: MedicationGroup, scheduled: LocalDateTime, applied: LocalDateTime, count: Int) =
        testMedicationLogEntry(
            medicine = plan.medications.first().medicine,
            applicationType = plan.medications.first().applicationType,
            doseInstruction = plan.medications.first().doseInstruction,
            sourceGroupUuid = plan.uuid,
            scheduledFor = scheduled,
            scheduleTimeUuid = plan.schedule.timeSlots.first().uuid,
            appliedAt = applied.atZone(utc).toInstant(),
            appliedAtTimeZoneId = utc.id,
            count = count,
        )

    private fun projection(values: List<Double> = listOf(100.0, 120.0, 110.0)) = PkProjectionResult(
        windowStart = Instant.parse("2026-10-21T08:00:00Z"),
        windowEnd = Instant.parse("2026-10-21T10:00:00Z"),
        concentrationUnit = PkConcentrationUnit.PG_PER_ML,
        timeH = listOf(0.0, 1.0, 2.0),
        concentrations = values,
        doseMarkers = emptyList(),
    )
}
