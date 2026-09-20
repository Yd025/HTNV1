"""Coverage must not include samples outside the arena."""
import unittest
from metrics import CoverageGrid
from sim.types import Arena


class CoverageBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.grid = CoverageGrid(Arena(0., 0., 100.), n=10)

    def test_samples_outside_every_edge_and_corner_are_rejected(self):
        for north, east in ((-101., 0.), (101., 0.), (0., -101.), (0., 101.),
                            (-101., -101.), (-101., 101.), (101., -101.), (101., 101.)):
            with self.subTest(north=north, east=east):
                self.assertIsNone(self.grid.cell_of_ne(north, east))

    def test_outside_samples_do_not_mark_boundary_cells(self):
        for point in ((-101., 0.), (0., -101.), (-101., -101.)):
            self.grid._touch(*point, now=10.)
        self.assertTrue(all(value < 0 for row in self.grid.last_seen for value in row))

    def test_interior_samples_retain_their_cells(self):
        for north, east, expected in ((0., 0., (5, 5)), (-99., -99., (0, 0)),
                                      (99., 99., (9, 9)), (-1., 1., (5, 4))):
            with self.subTest(north=north, east=east):
                self.assertEqual(self.grid.cell_of_ne(north, east), expected)

    def test_existing_half_open_boundary_convention_is_preserved(self):
        self.assertEqual(self.grid.cell_of_ne(-100., -100.), (0, 0))
        self.assertIsNone(self.grid.cell_of_ne(100., 0.))
        self.assertIsNone(self.grid.cell_of_ne(0., 100.))


if __name__ == "__main__":
    unittest.main()
