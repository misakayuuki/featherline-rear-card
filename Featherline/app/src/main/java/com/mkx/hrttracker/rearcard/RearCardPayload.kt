package com.mkx.hrttracker.rearcard

import com.mkx.hrttracker.data.repository.HomeSnapshotRecord
import com.mkx.hrttracker.model.bloodtest.BloodAnalyteKey
import com.mkx.hrttracker.model.bloodtest.BloodTestCatalog
import com.mkx.hrttracker.model.bloodtest.BloodUnitKey
import com.mkx.hrttracker.model.medication.MedicationGroup
import com.mkx.hrttracker.model.medication.MedicationLogEntry
import com.mkx.hrttracker.model.medication.buildPlanDaySchedule
import com.mkx.hrttracker.model.medication.nextOccurrencesInPlanWindowFrom
import com.mkx.hrttracker.model.pk.PkConcentrationUnit
import com.mkx.hrttracker.model.pk.PkProjectionResult
import com.mkx.hrttracker.model.settings.SettingsState
import com.mkx.hrttracker.widget.WidgetDoseStatus
import com.mkx.hrttracker.widget.WidgetSnapshotRecord
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.roundToLong

/** Only the explicitly enabled rear-screen summary leaves this app. */
object RearCardPayload {
    internal const val LOOKAHEAD_DAYS = 90L
    private const val VALIDITY_MILLIS = 24L * 60 * 60 * 1000
    private const val MAX_SERIES_POINTS = 2048
    private const val MAX_JSON_CHARS = 120_000

    fun build(
        home: HomeSnapshotRecord,
        widget: WidgetSnapshotRecord,
        projection: PkProjectionResult?,
        settings: SettingsState,
        now: LocalDateTime,
        zoneId: ZoneId,
    ): JSONObject {
        val generatedAt = now.atZone(zoneId).toInstant().toEpochMilli()
        val validUntil = generatedAt + VALIDITY_MILLIS
        val next = nextPendingDose(
            groups = home.activeGroups,
            entries = (home.scheduleEntries + home.stockFulfillmentEntries).distinctBy { it.uuid },
            now = now,
            zoneId = zoneId,
        )
        val nextJson = next?.let {
            JSONObject().apply {
                put("at", it.at.toEpochMilli())
                put("label", if (settings.hideMedicationDetails) "下一次用药" else it.label.take(64))
                put("timeText", it.at.atZone(zoneId).format(DateTimeFormatter.ofPattern("MM-dd HH:mm")))
            }
        }
        val series = projection?.let {
            displaySeries(it, settings.homeE2DisplayUnit, generatedAt, validUntil)
        }
        val result = JSONObject().apply {
            put("schema", 1)
            put("source", "Featherline")
            put("generatedAt", generatedAt)
            put("validUntil", validUntil)
            put("zoneId", zoneId.id)
            put("hideDetails", settings.hideMedicationDetails)
            put("today", JSONObject().apply {
                put("date", now.toLocalDate().toString())
                put("done", widget.doneCount)
                put("total", widget.totalCount)
                put("expiresAt", now.toLocalDate().plusDays(1).atStartOfDay(zoneId).toInstant().toEpochMilli())
            })
            put("nextDose", nextJson ?: JSONObject.NULL)
            put("nextDoseSearchLimited", next == null && home.activeGroups.isNotEmpty())
            put("overdueCount", widget.doseRows.count {
                !it.isManualRecord && it.contextChip == null && it.status == WidgetDoseStatus.OVERDUE
            })
            put("e2", series?.let {
                JSONObject().apply {
                    put("generatedAt", generatedAt)
                    put("windowStart", it.times.first())
                    put("windowEnd", it.times.last())
                    put("unit", it.unit)
                    put("times", JSONArray(it.times))
                    put("values", JSONArray(it.values))
                }
            } ?: JSONObject.NULL)
        }
        // Reject an unexpectedly expanded source format instead of truncating a curve silently.
        require(result.toString().length <= MAX_JSON_CHARS) { "Rear-card summary exceeds its size budget" }
        return result
    }

    internal data class NextDose(val at: Instant, val label: String)

    /** Uses the Plan page's fulfillment rules, including partial groups and out-of-window logs. */
    internal fun nextPendingDose(
        groups: List<MedicationGroup>,
        entries: List<MedicationLogEntry>,
        now: LocalDateTime,
        zoneId: ZoneId,
    ): NextDose? {
        val active = groups.filter {
            it.archivedAt == null && it.archivedAtLocal == null && it.medications.isNotEmpty()
        }
        val nowInstant = now.atZone(zoneId).toInstant()
        // Begin at local midnight, then compare actual instants below. During a DST gap,
        // a local 02:30 occurrence can resolve to 03:30 and still be in the future at 03:15.
        val candidateDates = active.flatMap { group ->
            group.nextOccurrencesInPlanWindowFrom(
                start = now.toLocalDate().atStartOfDay(),
                limit = Int.MAX_VALUE,
                lookaheadDays = LOOKAHEAD_DAYS,
                zoneId = zoneId,
            ).map { it.scheduledFor.toLocalDate() }
        }.distinct().sorted()
        for (date in candidateDates) {
            val next = buildPlanDaySchedule(
                date = date,
                groups = active,
                entries = entries,
                now = now,
                zoneId = zoneId,
                includeUnloggedArchivedSlots = false,
            ).scheduledEntries.asSequence()
                .filter { !it.isFulfilled && !it.hasOutsideScheduleWindowEntry }
                .map { row -> row to row.scheduledFor.atZone(zoneId).toInstant() }
                .filter { (_, at) -> !at.isBefore(nowInstant) }
                .minByOrNull { (_, at) -> at }
            if (next != null) {
                return NextDose(next.second, next.first.groupName.ifBlank { "下一次用药" })
            }
        }
        return null
    }

    internal data class E2Series(val unit: String, val times: List<Long>, val values: List<Double>)

    /**
     * Keep original adjacent samples (no new PK calculation or curve resampling), including
     * the bracketing points for 24 hours either side of this summary. This is the official
     * calibrated, logged-dose-only widget curve; a failed derivation stays absent.
     */
    internal fun displaySeries(
        projection: PkProjectionResult,
        requestedUnit: BloodUnitKey,
        generatedAt: Long,
        validUntil: Long,
    ): E2Series? {
        val hours = projection.timeH
        val sourceValues = projection.concentrations
        if (hours.size < 2 || hours.size != sourceValues.size) return null
        if (hours.indices.any { i ->
                !hours[i].isFinite() || !sourceValues[i].isFinite() || sourceValues[i] < 0 ||
                        (i > 0 && hours[i] <= hours[i - 1])
            }) return null
        val start = projection.windowStart.toEpochMilli()
        val end = projection.windowEnd.toEpochMilli()
        if (generatedAt < start || generatedAt >= end) return null
        val times = hours.map { hour -> start + (hour * 3_600_000.0).roundToLong() }
        if (times.zipWithNext().any { (a, b) -> a >= b }) return null
        if (generatedAt < times.first() || generatedAt > times.last()) return null
        val wantedStart = (generatedAt - Duration.ofHours(24).toMillis()).coerceAtLeast(start)
        val wantedEnd = validUntil.coerceAtMost(end)
        val first = times.indexOfLast { it <= wantedStart }.coerceAtLeast(0)
        val last = times.indexOfFirst { it >= wantedEnd }.let { if (it < 0) times.lastIndex else it }
        if (last <= first || last - first + 1 > MAX_SERIES_POINTS) return null
        val target = requestedUnit.takeIf { BloodTestCatalog.isUnitAllowed(BloodAnalyteKey.E2, it) }
            ?: BloodUnitKey.PG_ML
        val values = (first..last).map { i ->
            val canonical = when (projection.concentrationUnit) {
                PkConcentrationUnit.PG_PER_ML -> sourceValues[i]
                PkConcentrationUnit.PMOL_PER_L -> BloodTestCatalog.toCanonical(
                    BloodAnalyteKey.E2, sourceValues[i], BloodUnitKey.PMOL_L,
                )
                PkConcentrationUnit.NG_PER_DL -> BloodTestCatalog.toCanonical(
                    BloodAnalyteKey.E2, sourceValues[i], BloodUnitKey.NG_DL,
                )
                PkConcentrationUnit.NG_PER_ML -> sourceValues[i] * 1_000.0
                PkConcentrationUnit.NMOL_PER_L -> {
                    val pmol = sourceValues[i] * 1_000.0
                    if (!pmol.isFinite()) return null
                    BloodTestCatalog.toCanonical(BloodAnalyteKey.E2, pmol, BloodUnitKey.PMOL_L)
                }
            }
            if (!canonical.isFinite()) return null
            BloodTestCatalog.fromCanonical(BloodAnalyteKey.E2, canonical, target)
        }
        if (values.any { !it.isFinite() || it < 0 }) return null
        val label = when (target) {
            BloodUnitKey.PMOL_L -> "pmol/L"
            BloodUnitKey.NG_DL -> "ng/dL"
            else -> "pg/mL"
        }
        return E2Series(label, times.subList(first, last + 1), values)
    }
}
