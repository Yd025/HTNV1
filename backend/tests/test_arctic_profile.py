import math
import unittest

from PIL import Image

from export_arctic_profile import sampled_grid, safe_water, water_mask, water_segment, world_pixel


class ArcticProfileTests(unittest.TestCase):
    def test_world_rows_increase_northwhile_raster_rows_decrease(self):
        self.assertEqual(world_pixel(-100, -100, 100, 21), (0, 20))
        self.assertEqual(world_pixel(100, 100, 100, 21), (20, 0))
        self.assertEqual(world_pixel(0, 0, 100, 21), (10, 10))

    def test_low_land_is_not_misclassified_by_quantized_heightmap(self):
        dem = Image.new("F", (9, 9), 0.0)
        dem.putpixel((4, 4), 0.15)
        mask, radius = water_mask(dem, 1.0, 0.0)
        self.assertFalse(safe_water(mask, 4, 4, radius))
        self.assertTrue(safe_water(mask, 2, 2, radius))
        with self.assertRaisesRegex(ValueError, "float DEM"):
            water_mask(Image.new("L", (9, 9)), 1.0, 0.0)

    def test_shore_buffer_and_edge_buffer_remove_unsafe_water(self):
        dem = Image.new("F", (15, 15), 0.0)
        dem.putpixel((7, 7), 2.0)
        mask, radius = water_mask(dem, 1.0, 2.0)
        self.assertEqual(radius, 2)
        self.assertFalse(safe_water(mask, 5, 7, radius))
        self.assertFalse(safe_water(mask, 1, 3, radius))
        self.assertTrue(safe_water(mask, 3, 7, radius))

    def test_water_endpoints_do_not_allow_land_crossing(self):
        dem = Image.new("F", (15, 15), 0.0)
        for row in range(15):
            dem.putpixel((7, row), 0.1)
        mask, radius = water_mask(dem, 1.0, 0.0)
        self.assertFalse(water_segment(mask, (3, 7), (11, 7), radius))
        self.assertTrue(water_segment(mask, (3, 3), (3, 11), radius))

    def test_grid_heights_use_rendered_surface_and_no_diagonal_corner_cut(self):
        dem = Image.new("F", (21, 21), 0.0)
        heightmap = Image.new("L", (21, 21), 0)
        # Graph grid=5: center point=source(10,10), eastern neighbor=(15,10).
        dem.putpixel((15, 10), 20.0)
        heightmap.putpixel((10, 10), 100)
        result = sampled_grid(dem, heightmap, size=5, half_m=100, zmin=0, zrange=255, clearance_m=0)
        self.assertEqual(result["elevations"][12], 100.0)
        self.assertTrue(result["water"][12])
        self.assertTrue(result["water"][18])
        self.assertNotIn([12, 18], result["waterEdges"])
        self.assertTrue(all(math.isfinite(z) for z in result["elevations"]))


if __name__ == "__main__":
    unittest.main()
