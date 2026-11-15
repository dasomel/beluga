# Each location is a flat JSON object. Require both fields in the SAME object;
# matching the prefix in one location and fsync=true in another must fail.
BEGIN { RS = "}"; found = 0 }
{
  gsub(/[[:space:]]/, "")
  if (index($0, "\"locationPrefix\":\"" prefix "\"") &&
      $0 ~ /"fsync":true(,|$)/) found = 1
}
END { exit !found }
