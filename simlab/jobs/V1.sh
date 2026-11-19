# The apagón from U1's morning (as T1 from S1's), with run.py as on main after PR 54: a car's morning figures are
# carried into the blackout only if it left before the failure.
MODE=apagon FROM=U1 LIMIT=335 RUNARGS="--reroute=1 --reroute-period=300" . simlab/final.sh
