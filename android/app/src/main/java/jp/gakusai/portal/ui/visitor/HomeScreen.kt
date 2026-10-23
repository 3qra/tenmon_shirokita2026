package jp.gakusai.portal.ui.visitor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import jp.gakusai.portal.AppContainer
import jp.gakusai.portal.R
import jp.gakusai.portal.ui.common.ScreenScaffold

@Composable
fun HomeScreen(
    container: AppContainer,
    onOrder: () -> Unit,
    onPlanetarium: () -> Unit,
    onMyTickets: () -> Unit,
    onStaff: () -> Unit,
) {
    val saved by container.savedItems.items.collectAsStateWithLifecycle()
    val staff by container.staffSession.staff.collectAsStateWithLifecycle()
    ScreenScaffold(title = stringResource(R.string.app_name), onBack = null) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.home_welcome), style = MaterialTheme.typography.titleLarge)
            HomeCard(
                icon = Icons.Filled.ShoppingCart,
                title = stringResource(R.string.home_order_title),
                body = stringResource(R.string.home_order_body),
                onClick = onOrder,
            )
            HomeCard(
                icon = Icons.Filled.Star,
                title = stringResource(R.string.home_planetarium_title),
                body = stringResource(R.string.home_planetarium_body),
                onClick = onPlanetarium,
            )
            HomeCard(
                icon = Icons.Filled.Favorite,
                title = stringResource(R.string.home_mine_title),
                body = if (saved.isEmpty()) stringResource(R.string.home_mine_body_empty)
                else stringResource(R.string.home_mine_body_count, saved.size),
                onClick = onMyTickets,
            )
            Spacer(Modifier.size(8.dp))
            TextButton(onClick = onStaff, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Icon(Icons.Filled.Lock, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(
                    if (staff != null) stringResource(R.string.home_staff_logged_in, staff!!.name)
                    else stringResource(R.string.home_staff),
                )
            }
        }
    }
}

@Composable
private fun HomeCard(icon: ImageVector, title: String, body: String, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(40.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer)
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
                Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onPrimaryContainer)
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
        }
    }
}
