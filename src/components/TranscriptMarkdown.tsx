import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function TranscriptMarkdown({ text }: { text: string }) {
  return <div className="agent-transcript-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      img: ({ alt }) => <span className="agent-transcript-image" role="note">Image: {alt || "attachment"}</span>,
      table: ({ node: _node, ...props }) => <div className="agent-transcript-table"><table {...props} /></div>,
    }}>{text}</ReactMarkdown>
  </div>;
}
