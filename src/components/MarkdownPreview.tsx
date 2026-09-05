import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProps {
  content: string;
}

export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <div
      className="session-file-markdown-preview"
      role="document"
      aria-label="Rendered Markdown preview"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          img: ({ alt, src }) => (
            <span className="session-file-markdown-image-placeholder" role="note">
              Image not loaded: {alt || src || "unnamed image"}
            </span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
