import NewProjectForm from "./NewProjectForm";

export default function NewProjectPage() {
  return (
    <div className="max-w-lg">
      <h1 className="mb-5 text-lg font-semibold">새 프로젝트</h1>
      <NewProjectForm />
    </div>
  );
}
