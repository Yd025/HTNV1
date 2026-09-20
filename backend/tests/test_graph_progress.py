"""Completed-episode denominators and future isolation for live run monitoring."""
import copy
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from train_graph_search import progress_snapshot, save


def row(detected_at):
    return {"metrics":{"detectedAt":detected_at,"detectionRate":100 if detected_at is not None else 0,
            "meanCappedS":detected_at if detected_at is not None else 300,"coveragePct":20,
            "custodyPct":50,"estimateAvailabilityPct":50,"distanceM":100,"handoffs":1,
            "estimateSamples":2,"squaredErrorSum":8,"bySource":{"plane":1}}}


class GraphProgressTests(unittest.TestCase):
    def test_each_partial_policy_uses_its_own_completed_denominator(self):
        rows={"baseline":[row(0),row(10),row(None),row(300)],"untrained":[row(5),row(None)]}
        progress=progress_snapshot(rows,"untrained",300,5)
        self.assertEqual(progress["evaluatingPolicy"],"untrained")
        self.assertEqual(progress["partialMetrics"]["baseline"]["episodes"],4)
        self.assertEqual(progress["partialMetrics"]["baseline"]["detectionRate"],75)
        self.assertEqual(progress["partialMetrics"]["untrained"]["episodes"],2)
        self.assertEqual(progress["partialMetrics"]["untrained"]["detectionRate"],50)
        self.assertNotIn("trained",progress["partialMetrics"])
        curve=progress["partialDetectionCurve"]
        self.assertEqual(curve[0],{"t":0,"baseline":25,"untrained":0,"trained":None})
        self.assertEqual(curve[1],{"t":5,"baseline":25,"untrained":50,"trained":None})
        self.assertEqual(curve[-1],{"t":300,"baseline":75,"untrained":50,"trained":None})

    def test_unstarted_policies_are_unavailable_not_zero_performance(self):
        progress=progress_snapshot({},"baseline",300,5)
        self.assertEqual(progress["partialMetrics"],{})
        self.assertEqual(len(progress["partialDetectionCurve"]),61)
        self.assertTrue(all(point[label] is None for point in progress["partialDetectionCurve"]
                            for label in ("baseline","untrained","trained")))
        self.assertNotIn("NaN",json.dumps(progress,allow_nan=False))

    def test_snapshot_does_not_mutate_inputs_or_change_after_later_completion(self):
        rows={"baseline":[row(None),row(100)]}
        before=copy.deepcopy(rows)
        early=progress_snapshot(rows,"baseline",300,5)
        early_copy=copy.deepcopy(early)
        self.assertEqual(rows,before)
        rows["baseline"].extend([row(0),row(0)])
        rows["trained"]=[row(0)]
        later=progress_snapshot(rows,"trained",300,5)
        self.assertEqual(early,early_copy)
        self.assertEqual(early["partialMetrics"]["baseline"]["episodes"],2)
        self.assertEqual(later["partialMetrics"]["baseline"]["episodes"],4)
        self.assertIsNone(early["partialDetectionCurve"][-1]["trained"])
        self.assertEqual(later["partialDetectionCurve"][-1]["trained"],100)

    def test_complete_progress_matches_report_metrics_and_curve(self):
        from pathlib import Path
        report=json.loads((Path(__file__).parents[2]/"frontend/public/experiments/graph-report.json").read_text())
        rows={label:[{"metrics":metric} for metric in metrics] for label,metrics in report["perEpisode"].items()}
        progress=progress_snapshot(rows,"trained",report["protocol"]["horizonS"],report["protocol"]["stepS"])
        self.assertEqual(progress["partialMetrics"],report["metrics"])
        self.assertEqual(progress["partialDetectionCurve"],report["detectionCurve"])

    def test_atomic_progress_publication_retries_transient_reader_lock(self):
        original=Path.replace
        attempts=[]
        def locked_once(path,destination):
            attempts.append(path)
            if len(attempts)==1:
                raise PermissionError("reader holds destination")
            return original(path,destination)
        with TemporaryDirectory() as directory:
            destination=Path(directory)/"progress.json"
            destination.write_text('{"phase":"previous"}')
            with patch.object(Path,"replace",autospec=True,side_effect=locked_once),patch("train_graph_search.time.sleep") as sleep:
                save(destination,{"phase":"test","testCompleted":10})
            self.assertEqual(len(attempts),2)
            sleep.assert_called_once_with(.01)
            self.assertEqual(json.loads(destination.read_text()),{"phase":"test","testCompleted":10})


if __name__=="__main__": unittest.main()
