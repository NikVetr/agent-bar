import unittest

from agent_bar import git


class GitSummaryTests(unittest.TestCase):
    def test_numstat_counts_lines_and_lists_the_most_changed_files(self):
        summary = git.parse_numstat('3\t1\tsrc/a.py\n-\t-\tlogo.png\n40\t2\tsrc/b.py\n')
        self.assertEqual((summary['files'], summary['added'], summary['removed']), (3, 43, 3))
        self.assertEqual(summary['top'][0], ['src/b.py', 40, 2])

    def test_checks_read_as_one_word(self):
        self.assertIsNone(git.checks_state([]))
        self.assertEqual(git.checks_state([{'status': 'COMPLETED', 'conclusion': 'SUCCESS'}]), 'passing')
        self.assertEqual(git.checks_state([{'status': 'COMPLETED', 'conclusion': 'SUCCESS'}, {'status': 'IN_PROGRESS'}]), 'pending')
        self.assertEqual(git.checks_state([{'state': 'PENDING'}, {'status': 'COMPLETED', 'conclusion': 'FAILURE'}]), 'failing')
        # Commit statuses carry a state and no status.
        self.assertEqual(git.checks_state([{'state': 'SUCCESS'}]), 'passing')


if __name__ == '__main__':
    unittest.main()
