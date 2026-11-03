import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * The application root.
 *
 * It only hosts the router. Loading feedback lives where it can be seen in
 * context: the shell shows a loader over the content while a page opens, tables
 * show their own, and a small indicator in the top bar shows background requests.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}