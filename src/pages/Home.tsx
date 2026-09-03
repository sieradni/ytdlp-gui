import Composer from "../components/Composer";
import QueueTable from "../components/QueueTable";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-[860px] px-5 pt-4 pb-9">
      <Composer />
      <QueueTable />
    </div>
  );
}
