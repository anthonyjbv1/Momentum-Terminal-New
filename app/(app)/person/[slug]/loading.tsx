import { BackLink } from "@/components/person/back-link";
import { ProfileSkeleton } from "@/components/person/profile-skeleton";

/**
 * Route-level loading state (2026-10-02): the profile's own shape, shown the
 * moment a person is tapped, while the slug is resolved on the server. Home,
 * Feed and Portfolio always had one; the person page did not, so a tap
 * showed nothing until the first query answered.
 */
export default function PersonLoading() {
  return (
    <div className="flex flex-col gap-10 pb-28 md:pb-0">
      <BackLink />
      <ProfileSkeleton />
    </div>
  );
}
