### Algorithm and optimization

Freeze combines complementary search routes, camera-aware flight paths, and confirmed sensor handoffs. A constant-velocity Kalman filter estimates ship position, velocity, and uncertainty while rejecting stale or implausible observations.

Our offline optimizer selects tower positions and six flight settings using separate training and validation missions, then freezes the strategy before evaluation.

### Results

We compared our current strategy against release 0.2 on **400 matching, unseen synthetic missions**:

| Metric | Release 0.2 | Current |
|---|---:|---:|
| Confirmed ship detection | 68.75% | 70.00% |
| Aircraft tracking custody | 24.07% | 29.80% |
| Mean longest contact gap | 113.98 s | 106.28 s |

Aircraft custody measures the share of sampled mission time with confirmed, fresh aircraft contact. Its **5.73-percentage-point improvement** was statistically supported. Detection and gap improvements remained uncertain. Search coverage decreased, while position error and false contacts increased.

Our next priority is validating live camera performance and addressing these tradeoffs.
